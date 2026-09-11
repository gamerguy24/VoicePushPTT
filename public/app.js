'use strict';

// Walkie-talkie client.
//
// Every member of a channel holds a WebRTC connection to every other member
// (full mesh) with our microphone track attached but disabled. Pressing the
// PTT button asks the server for the floor; once granted we enable the mic
// track, and every listener un-mutes only the current talker's audio.

const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  myId: null,
  name: '',
  channel: '',
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  localStream: null,
  micTrack: null,
  /** @type {Map<string, {id: string, name: string, pc: RTCPeerConnection, audio: HTMLAudioElement, queue: Promise<void>, pending: RTCIceCandidateInit[]}>} */
  peers: new Map(),
  talker: null,          // { id, name } of whoever holds the floor, or null
  floor: 'idle',         // idle | requesting | talking
  pressing: false,
  wantConnected: false,
  reconnectTimer: null,
  txStartedAt: 0,
  rxStartedAt: 0,
  volume: 1,
};

// ---------------------------------------------------------------------------
// Tones (generated, so no audio assets are needed)

let audioCtx = null;

const TONES = {
  permit: [[880, 60], [1320, 90]],
  roger: [[1250, 50], [880, 80]],
  busy: [[420, 130], [0, 70], [420, 130]],
  rxStart: [[700, 60]],
  rxEnd: [[520, 70]],
};

function playTone(name) {
  if (!audioCtx) return;
  let t = audioCtx.currentTime + 0.01;
  for (const [freq, ms] of TONES[name]) {
    const dur = ms / 1000;
    if (freq > 0) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.18, t + 0.006);
      gain.gain.setValueAtTime(0.18, t + dur - 0.012);
      gain.gain.linearRampToValueAtTime(0, t + dur);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + dur);
    }
    t += dur;
  }
  return (t - audioCtx.currentTime) * 1000;
}

// ---------------------------------------------------------------------------
// Signaling

function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
}

function sendSignal(to, data) {
  send({ type: 'signal', to, data });
}

function connect() {
  clearTimeout(state.reconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;
  setConn('warn', 'Connecting…');

  ws.onopen = () => {
    send({ type: 'join', name: state.name, channel: state.channel });
  };

  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleMessage(msg);
  };

  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.ws = null;
    if (state.floor !== 'idle') stopTransmit(false);
    setTalker(null, true);
    closeAllPeers();
    if (state.wantConnected) {
      setConn('warn', 'Reconnecting…');
      state.reconnectTimer = setTimeout(connect, 2000);
    }
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'joined':
      state.myId = msg.id;
      $('channelName').textContent = msg.channel;
      setConn('ok', 'Connected');
      for (const p of msg.peers) addPeer(p.id, p.name, true);
      setTalker(msg.talker, true);
      renderMembers();
      break;

    case 'peer-joined':
      addPeer(msg.id, msg.name, false);
      logSystem(`${msg.name} joined`);
      renderMembers();
      break;

    case 'peer-left': {
      const peer = state.peers.get(msg.id);
      if (peer) logSystem(`${peer.name} left`);
      removePeer(msg.id);
      renderMembers();
      break;
    }

    case 'signal':
      handleSignal(msg.from, msg.data);
      break;

    case 'talker':
      setTalker(msg.talker);
      break;

    case 'floor-granted':
      onFloorGranted();
      break;

    case 'floor-denied':
      state.floor = 'idle';
      playTone('busy');
      flashStatus(`${msg.talker ? msg.talker.name : 'Someone'} is talking`, 'warn');
      render();
      break;

    case 'floor-revoked':
      stopTransmit(false);
      flashStatus('Max talk time reached', 'warn');
      break;

    case 'error':
      showLoginError(msg.message);
      break;
  }
}

// ---------------------------------------------------------------------------
// WebRTC mesh

function addPeer(id, name, initiator) {
  const existing = state.peers.get(id);
  if (existing) {
    if (name) existing.name = name;
    return existing;
  }

  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.playsInline = true;
  audio.muted = true;
  audio.volume = state.volume;
  $('remoteAudio').appendChild(audio);

  const peer = { id, name: name || '…', pc, audio, queue: Promise.resolve(), pending: [] };
  state.peers.set(id, peer);

  pc.addTrack(state.micTrack, state.localStream);

  pc.onicecandidate = ({ candidate }) => {
    if (candidate) sendSignal(id, { candidate });
  };

  pc.ontrack = ({ streams }) => {
    audio.srcObject = streams[0];
    audio.play().catch(() => {});
  };

  pc.onconnectionstatechange = () => renderMembers();

  // The newcomer makes the offers; existing members only answer. That way
  // both sides never offer at once and no glare handling is needed.
  if (initiator) {
    peer.queue = peer.queue.then(async () => {
      await pc.setLocalDescription(await pc.createOffer());
      sendSignal(id, { sdp: pc.localDescription });
    }).catch((err) => console.warn('offer failed', err));
  }

  return peer;
}

function handleSignal(from, data) {
  const peer = state.peers.get(from) || addPeer(from, '', false);
  const { pc } = peer;

  // Process each peer's signals strictly in order.
  peer.queue = peer.queue.then(async () => {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        sendSignal(from, { sdp: pc.localDescription });
      }
      for (const c of peer.pending.splice(0)) await pc.addIceCandidate(c);
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(data.candidate);
      else peer.pending.push(data.candidate);
    }
  }).catch((err) => console.warn('signal failed', err));
}

function removePeer(id) {
  const peer = state.peers.get(id);
  if (!peer) return;
  peer.pc.close();
  peer.audio.srcObject = null;
  peer.audio.remove();
  state.peers.delete(id);
}

function closeAllPeers() {
  for (const id of [...state.peers.keys()]) removePeer(id);
  renderMembers();
}

// ---------------------------------------------------------------------------
// Floor control / push-to-talk

function setTalker(talker, silent = false) {
  const prev = state.talker;
  state.talker = talker;

  for (const peer of state.peers.values()) {
    peer.audio.muted = !(talker && talker.id === peer.id);
  }

  const wasRemote = prev && prev.id !== state.myId;
  const isRemote = talker && talker.id !== state.myId;

  if (isRemote && (!prev || prev.id !== talker.id)) {
    state.rxStartedAt = Date.now();
    if (!silent) playTone('rxStart');
  }
  if (wasRemote && (!talker || talker.id !== prev.id)) {
    if (!silent) playTone('rxEnd');
    if (state.rxStartedAt) logTalk(prev.name, Date.now() - state.rxStartedAt);
    state.rxStartedAt = 0;
  }

  render();
  renderMembers();
}

function pttDown() {
  if (state.pressing) return;
  state.pressing = true;

  if (!state.ws || state.ws.readyState !== WebSocket.OPEN || !state.myId) {
    playTone('busy');
    flashStatus('Not connected', 'warn');
    state.pressing = false;
    return;
  }
  if (state.talker && state.talker.id !== state.myId) {
    playTone('busy');
    flashStatus(`${state.talker.name} is talking`, 'warn');
    state.pressing = false;
    return;
  }

  state.floor = 'requesting';
  send({ type: 'ptt-start' });
  render();
}

function pttUp() {
  if (!state.pressing) return;
  state.pressing = false;
  if (state.floor === 'talking') stopTransmit(true);
  // If still 'requesting', onFloorGranted() will see pressing === false and hand the floor back.
  render();
}

function onFloorGranted() {
  if (!state.pressing) {
    send({ type: 'ptt-stop' });
    state.floor = 'idle';
    render();
    return;
  }

  state.floor = 'talking';
  state.txStartedAt = Date.now();
  // Open the mic after the permit chirp so listeners don't get it echoed back.
  const chirpMs = playTone('permit') || 0;
  setTimeout(() => {
    if (state.floor === 'talking') state.micTrack.enabled = true;
  }, chirpMs);
  render();
}

function stopTransmit(notifyServer) {
  if (state.micTrack) state.micTrack.enabled = false;
  if (notifyServer) send({ type: 'ptt-stop' });
  if (state.floor === 'talking') {
    playTone('roger');
    logTalk(`${state.name} (you)`, Date.now() - state.txStartedAt);
  }
  state.floor = 'idle';
  state.pressing = false;
  render();
}

// ---------------------------------------------------------------------------
// Microphone level meter

let analyser = null;

function startMeter() {
  const source = audioCtx.createMediaStreamSource(state.localStream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  const fill = $('meterFill');

  const tick = () => {
    if (!analyser) return;
    let level = 0;
    if (state.floor === 'talking') {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
    }
    fill.style.width = `${Math.round(level * 100)}%`;
    requestAnimationFrame(tick);
  };
  tick();
}

// ---------------------------------------------------------------------------
// UI

let flashTimer = null;
let flash = null;

function flashStatus(text, kind) {
  flash = { text, kind };
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { flash = null; render(); }, 1800);
  render();
}

function render() {
  const btn = $('ptt');
  const label = $('pttLabel');
  const status = $('status');
  const remoteTalker = state.talker && state.talker.id !== state.myId ? state.talker : null;
  const toggle = $('toggleMode').checked;

  btn.className = 'ptt';
  let text = 'Ready';
  let kind = '';

  if (state.floor === 'talking') {
    btn.classList.add('talking');
    label.textContent = toggle ? 'Tap to stop' : 'Talking…';
    text = 'You are talking';
    kind = 'tx';
  } else if (state.floor === 'requesting') {
    btn.classList.add('requesting');
    label.textContent = 'Wait…';
    text = 'Requesting channel…';
    kind = 'warn';
  } else if (remoteTalker) {
    btn.classList.add('receiving');
    label.textContent = 'Channel busy';
    text = `${remoteTalker.name} is talking`;
    kind = 'rx';
  } else {
    label.textContent = toggle ? 'Tap to talk' : 'Hold to talk';
  }

  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) btn.classList.add('disabled');

  if (flash) ({ text, kind } = flash);
  status.textContent = text;
  status.className = `status ${kind}`;
}

function renderMembers() {
  const list = $('members');
  list.textContent = '';

  const rows = [{ id: state.myId, name: state.name, me: true }, ...state.peers.values()];
  for (const m of rows) {
    const li = document.createElement('li');
    const talking = state.talker && state.talker.id === m.id;
    li.className = `${m.me ? 'me' : ''} ${talking ? 'talking' : ''}`;

    const dot = document.createElement('span');
    const pcState = m.me ? 'connected' : m.pc.connectionState;
    dot.className = `dot ${pcState === 'connected' ? 'ok' : pcState === 'failed' ? '' : 'warn'}`;
    dot.title = m.me ? 'You' : `Audio link: ${pcState}`;

    const name = document.createElement('span');
    name.textContent = m.name;
    li.append(dot, name);

    if (m.me) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = '(you)';
      li.append(tag);
    } else if (pcState === 'failed') {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'no audio link';
      li.append(tag);
    }

    if (talking) {
      const wave = document.createElement('span');
      wave.className = 'wave';
      wave.textContent = '🔊 talking';
      li.append(wave);
    }
    list.append(li);
  }
  $('onlineCount').textContent = rows.length;
}

function setConn(kind, text) {
  $('connDot').className = `dot ${kind}`;
  $('connText').textContent = text;
  render();
}

function addLogEntry(build) {
  const li = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  li.append(time);
  build(li);
  const log = $('log');
  log.prepend(li);
  while (log.children.length > 50) log.lastChild.remove();
}

function logTalk(who, ms) {
  addLogEntry((li) => {
    const name = document.createElement('span');
    name.textContent = who;
    const dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = `${(ms / 1000).toFixed(1)}s`;
    li.append(name, dur);
  });
}

function logSystem(text) {
  addLogEntry((li) => {
    const span = document.createElement('span');
    span.className = 'sys';
    span.textContent = text;
    li.append(span);
  });
}

function showLoginError(text) {
  const el = $('loginError');
  el.textContent = text;
  el.hidden = !text;
}

// ---------------------------------------------------------------------------
// Join / leave

async function join(e) {
  e.preventDefault();
  showLoginError('');

  const name = $('nameInput').value.trim();
  const channel = $('channelInput').value.trim().toLowerCase();
  if (!name || !channel) return;

  if (!navigator.mediaDevices || !window.RTCPeerConnection) {
    showLoginError('This page needs HTTPS (or localhost) and a browser with WebRTC to use the microphone.');
    return;
  }

  $('joinBtn').disabled = true;
  try {
    audioCtx = new AudioContext();
    await audioCtx.resume();

    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    state.micTrack = state.localStream.getAudioTracks()[0];
    state.micTrack.enabled = false;

    try {
      const cfg = await (await fetch('config.json')).json();
      if (Array.isArray(cfg.iceServers)) state.iceServers = cfg.iceServers;
    } catch { /* keep default STUN */ }
  } catch (err) {
    showLoginError(`Could not access the microphone: ${err.message}`);
    teardownMedia();
    $('joinBtn').disabled = false;
    return;
  }

  state.name = name;
  state.channel = channel;
  try {
    localStorage.setItem('walkie.name', name);
    localStorage.setItem('walkie.channel', channel);
  } catch { /* storage unavailable */ }
  history.replaceState(null, '', `?channel=${encodeURIComponent(channel)}`);

  $('channelName').textContent = channel;
  $('log').textContent = '';
  $('login').hidden = true;
  $('radio').hidden = false;
  $('joinBtn').disabled = false;

  startMeter();
  state.wantConnected = true;
  connect();
  renderMembers();
}

function teardownMedia() {
  analyser = null;
  if (state.localStream) state.localStream.getTracks().forEach((t) => t.stop());
  state.localStream = null;
  state.micTrack = null;
  if (audioCtx) audioCtx.close().catch(() => {});
  audioCtx = null;
}

function leaveChannel() {
  state.wantConnected = false;
  clearTimeout(state.reconnectTimer);
  if (state.floor !== 'idle') stopTransmit(true);
  send({ type: 'leave' });
  const ws = state.ws;
  state.ws = null;
  if (ws) ws.close();
  setTalker(null, true);
  closeAllPeers();
  teardownMedia();
  state.myId = null;
  $('radio').hidden = true;
  $('login').hidden = false;
}

// ---------------------------------------------------------------------------
// Wiring

function isTyping(e) {
  return e.target instanceof HTMLInputElement && e.target.type !== 'checkbox' && e.target.type !== 'range';
}

function init() {
  const params = new URLSearchParams(location.search);
  try {
    $('nameInput').value = localStorage.getItem('walkie.name') || '';
    $('channelInput').value = params.get('channel') || localStorage.getItem('walkie.channel') || '';
    $('toggleMode').checked = localStorage.getItem('walkie.toggle') === '1';
  } catch {
    $('channelInput').value = params.get('channel') || '';
  }

  $('joinForm').addEventListener('submit', join);
  $('leaveBtn').addEventListener('click', leaveChannel);

  const btn = $('ptt');
  btn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if ($('toggleMode').checked) {
      if (state.pressing) pttUp(); else pttDown();
      return;
    }
    btn.setPointerCapture(e.pointerId);
    pttDown();
  });
  const release = () => { if (!$('toggleMode').checked) pttUp(); };
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointercancel', release);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || isTyping(e) || $('radio').hidden) return;
    e.preventDefault();
    pttDown();
  });
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || $('radio').hidden) return;
    e.preventDefault();
    pttUp();
  });
  // Never leave the mic stuck open if the window loses focus mid-transmission.
  window.addEventListener('blur', () => { if (!$('toggleMode').checked) pttUp(); });

  $('toggleMode').addEventListener('change', (e) => {
    try { localStorage.setItem('walkie.toggle', e.target.checked ? '1' : '0'); } catch { /* ignore */ }
    render();
  });

  $('volume').addEventListener('input', (e) => {
    state.volume = Number(e.target.value);
    for (const peer of state.peers.values()) peer.audio.volume = state.volume;
  });
}

init();
