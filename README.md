# Walkie — push-to-talk over WebRTC

A Zello-style walkie-talkie that runs in the browser. Join a channel, hold the
button (or <kbd>Space</kbd>), talk. Everyone on the channel hears you, and only
one person can hold the channel at a time.

## Run it

```bash
npm install
npm start          # http://localhost:8080
```

Open it in two browser tabs (or two devices), use the same channel name, and
hold the big button.

### Using phones / other computers

Browsers only allow microphone access on **HTTPS** or `localhost`. For other
devices, pick one of these:

- **A tunnel (easiest):** `npx cloudflared tunnel --url http://localhost:8080`
  (or ngrok) gives you a public `https://` URL.
- **Your own certificate:** create one (e.g. with `mkcert`), then
  ```bash
  HTTPS_KEY=key.pem HTTPS_CERT=cert.pem npm start
  ```

Share a link like `https://your-host/?channel=team-alpha` to pre-fill the channel.

## Configuration (environment variables)

| Variable      | Default                              | Purpose                                   |
|---------------|--------------------------------------|-------------------------------------------|
| `PORT`        | `8080`                               | Listen port                               |
| `MAX_TALK_MS` | `60000`                              | Longest single transmission before the server takes the floor back |
| `ICE_SERVERS` | `[{"urls":"stun:stun.l.google.com:19302"}]` | JSON array passed to `RTCPeerConnection` |
| `HTTPS_KEY` / `HTTPS_CERT` | —                       | Serve over HTTPS                          |

Behind strict NATs or corporate firewalls, STUN isn't enough. Add a TURN server:

```bash
ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]' npm start
```

## How it works

```
 browser A ──┐  WebSocket: join / SDP+ICE relay / floor control  ┌── browser B
             └────────────────► server.js ◄──────────────────────┘
 browser A ◄═════════════ WebRTC audio (Opus, DTLS-SRTP) ═════════════► browser B
```

- **Signaling (`server.js`)**: one small Node server serves the page and runs a
  WebSocket at `/ws`. It tracks channels and members and relays SDP and ICE
  between peers. Audio never goes through it.
- **Mesh audio**: each member has a direct `RTCPeerConnection` to every other
  member in the channel. The newcomer sends the offers and existing members
  answer, so both sides never offer at once.
- **Floor control**: pressing PTT sends `ptt-start`. The server grants the floor
  if nobody else has it (`floor-granted`) or refuses (`floor-denied`, which
  plays a busy tone), then tells everyone who is talking. The talker's mic
  track is enabled only while they hold the floor. Listeners un-mute only the
  current talker's audio.
- **Tones**: the permit chirp, roger beep, busy and receive tones are made with
  the Web Audio API, so the app needs no audio files.
- Echo cancellation, noise suppression and auto-gain come from the browser's
  `getUserMedia` audio processing. Opus is WebRTC's default voice codec.

## Limits and next steps

- A full mesh works well up to about 8–10 people per channel. Larger channels
  need an SFU (e.g. mediasoup, LiveKit or Janus): each client uploads once and
  the server forwards the talker's audio.
- There is no auth, and channels are open to anyone who knows the name. Add
  login and per-channel passwords before exposing it publicly.
- Messages are live only. Zello-style message history and replay would mean
  recording each transmission (`MediaRecorder`) and storing it on the server.
