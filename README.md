# VoicePushPTT

**A free, open-source push-to-talk walkie-talkie for your PC, for everyone who's
tired of the Zello PC app.**

Hold a key, talk, and everyone on your channel hears you. There's no account to
create and no server to run. Voice goes directly between people over encrypted
WebRTC. The app itself is called **Walkie**.

> VoicePushPTT is an independent project. It is not affiliated with, endorsed
> by, or based on Zello. It was written from scratch and contains no Zello code.
> "Zello" is a trademark of Zello Inc.

## Why VoicePushPTT?

- **No sign-up.** Pick a name and a channel and start talking.
- **No central server.** People find each other through the public Nostr relay
  network, then talk peer-to-peer. There's nothing to host or pay for.
- **Desktop and browser.** A proper Windows desktop app, plus a single HTML file
  that runs in any browser, including on phones. Both join the same channels.
- **Open source (MIT).** Read it, change it, fork it, host it yourself.

## Features

- **Push-to-talk:** one talker per channel, with a talk-permit chirp, roger beep
  and busy tone.
- **Global talk key (desktop):** works while you're in any other app or game.
  Use a keyboard key or a mouse side button.
- **VOX:** voice-activated talking with an adjustable threshold and hang time.
- **Satellite map:** opt-in location sharing, with a pin for each person that
  pulses while they talk.
- **Local history:** replay past transmissions. Kept only on your computer;
  delete it any time or have it removed automatically after 1, 7 or 30 days.
- **Channel passwords:** everyone on a channel must use the same one.
- **Settings:** microphone and speaker choice, echo cancellation, noise
  suppression, light and dark themes, notifications, start with Windows, and
  running in the tray.

## Get started

### Desktop app (Windows, also macOS and Linux)

```bash
cd electron
npm install
npm start        # run from source
npm run dist     # build an installer and a portable .exe into electron/dist/
```

Default talk key: **F8**. Change it in ⚙ Settings › Controls. See
[electron/README.md](electron/README.md) for details.

### Single file, any browser

Open [`serverless/walkie.html`](serverless/walkie.html) in Chrome, Edge,
Firefox or Safari. Send the file to friends, or put it on any static host
(GitHub Pages, Netlify, …) so phones can use it too. See
[serverless/README.md](serverless/README.md).

### Server version

A classic client/server version with a small Node signaling server. See
[SERVER.md](SERVER.md).

## How it works

```
  You ──(encrypted connection offer)──►  public Nostr relays  ◄──(answer)── Friend
  You ◄══════════ direct WebRTC: voice (Opus) + control messages ══════════► Friend
```

- The relays only help people find each other. Voice, push-to-talk messages and
  locations go directly between browsers and are always encrypted.
- Who holds the channel is decided without a server: every talk request carries
  a timestamp, and every client picks the same winner.
- Each person connects to everyone else on the channel, which works well for up
  to about 8–10 people per channel.

## Project layout

| Path | What it is |
|------|------------|
| `serverless/walkie.html` | The whole app in one file: UI, WebRTC, map, settings, history |
| `electron/` | Desktop app: global talk key, tray, installers (uses `walkie.html`) |
| `server.js`, `public/` | Server version (Node signaling server + web client) |

## Contributing

Issues and pull requests are welcome. The app's code lives in
`serverless/walkie.html`. The desktop app copies it with `npm run sync`, so
make changes there.

## Notes

- **Map key:** the map uses MapTiler. If you fork or host this project, get
  your own free key at [maptiler.com](https://www.maptiler.com/) and replace
  `MAP_STYLE` in `walkie.html`.
- **Strict networks:** some corporate or mobile networks block direct
  connections. Add a TURN server under *Advanced* on the join screen.

## License

[MIT](LICENSE) © 2026 gamerguy24

Bundled libraries: [Trystero](https://github.com/dmotz/trystero) (MIT) and
[MapLibre GL JS](https://maplibre.org/) (BSD-3-Clause). Map data © MapTiler
© OpenStreetMap contributors.
