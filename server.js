'use strict';

// Signaling + floor-control server for the WebRTC walkie-talkie.
// Audio never passes through here: peers connect to each other directly
// (full mesh per channel). The server only relays SDP/ICE and decides who
// holds the floor, so exactly one person talks per channel at a time.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const MAX_TALK_MS = Number(process.env.MAX_TALK_MS) || 60_000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const ICE_SERVERS = process.env.ICE_SERVERS
  ? JSON.parse(process.env.ICE_SERVERS)
  : [{ urls: 'stun:stun.l.google.com:19302' }];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }

  if (pathname === '/config.json') {
    res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ iceServers: ICE_SERVERS }));
    return;
  }

  if (pathname === '/') pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = process.env.HTTPS_KEY && process.env.HTTPS_CERT
  ? https.createServer(
      { key: fs.readFileSync(process.env.HTTPS_KEY), cert: fs.readFileSync(process.env.HTTPS_CERT) },
      serveStatic,
    )
  : http.createServer(serveStatic);

// ---------------------------------------------------------------------------
// Channels & floor control

/** @type {Map<string, {name: string, members: Map<string, any>, talker: string|null, talkTimer: any}>} */
const channels = new Map();

function getChannel(name) {
  let ch = channels.get(name);
  if (!ch) {
    ch = { name, members: new Map(), talker: null, talkTimer: null };
    channels.set(name, ch);
  }
  return ch;
}

function send(client, msg) {
  if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(msg));
}

function broadcast(ch, msg, exceptId) {
  for (const member of ch.members.values()) {
    if (member.id !== exceptId) send(member, msg);
  }
}

function talkerInfo(ch) {
  const t = ch.talker && ch.members.get(ch.talker);
  return t ? { id: t.id, name: t.name } : null;
}

function releaseFloor(ch) {
  clearTimeout(ch.talkTimer);
  ch.talkTimer = null;
  ch.talker = null;
  broadcast(ch, { type: 'talker', talker: null });
}

function leave(client) {
  const ch = client.channel;
  if (!ch) return;
  ch.members.delete(client.id);
  client.channel = null;
  if (ch.talker === client.id) releaseFloor(ch);
  broadcast(ch, { type: 'peer-left', id: client.id });
  if (ch.members.size === 0) {
    clearTimeout(ch.talkTimer);
    channels.delete(ch.name);
  }
}

const handlers = {
  join(client, msg) {
    const name = String(msg.name || '').trim().slice(0, 32);
    const channelName = String(msg.channel || '').trim().toLowerCase().slice(0, 48);
    if (!name || !channelName) {
      send(client, { type: 'error', message: 'Name and channel are required.' });
      return;
    }

    leave(client);
    const ch = getChannel(channelName);
    const peers = [...ch.members.values()].map(({ id, name }) => ({ id, name }));

    client.name = name;
    client.channel = ch;
    ch.members.set(client.id, client);

    send(client, { type: 'joined', id: client.id, channel: ch.name, peers, talker: talkerInfo(ch) });
    broadcast(ch, { type: 'peer-joined', id: client.id, name }, client.id);
  },

  leave(client) {
    leave(client);
  },

  // Relay SDP offers/answers and ICE candidates between members of the same channel.
  signal(client, msg) {
    const target = client.channel && client.channel.members.get(msg.to);
    if (target) send(target, { type: 'signal', from: client.id, data: msg.data });
  },

  'ptt-start'(client) {
    const ch = client.channel;
    if (!ch) return;
    if (ch.talker && ch.talker !== client.id) {
      send(client, { type: 'floor-denied', talker: talkerInfo(ch) });
      return;
    }

    ch.talker = client.id;
    clearTimeout(ch.talkTimer);
    ch.talkTimer = setTimeout(() => {
      if (ch.talker !== client.id) return;
      send(client, { type: 'floor-revoked' });
      releaseFloor(ch);
    }, MAX_TALK_MS);

    send(client, { type: 'floor-granted', maxTalkMs: MAX_TALK_MS });
    broadcast(ch, { type: 'talker', talker: talkerInfo(ch) });
  },

  'ptt-stop'(client) {
    const ch = client.channel;
    if (ch && ch.talker === client.id) releaseFloor(ch);
  },
};

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws) => {
  const client = { id: crypto.randomUUID(), ws, name: '', channel: null, alive: true };

  ws.on('pong', () => { client.alive = true; });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const handler = msg && handlers[msg.type];
    if (handler) handler(client, msg);
  });

  ws.on('close', () => leave(client));
  ws.on('error', () => ws.terminate());
  ws.client = client;
});

// Drop connections that stop answering pings (phone went to sleep, network changed...).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.client.alive) {
      ws.terminate();
      continue;
    }
    ws.client.alive = false;
    ws.ping();
  }
}, 30_000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  const proto = server instanceof https.Server ? 'https' : 'http';
  console.log(`Walkie-talkie running at ${proto}://localhost:${PORT}`);
});
