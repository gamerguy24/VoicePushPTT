# Walkie Desktop (Electron)

The serverless walkie-talkie as a desktop app for Windows, macOS and Linux. It
uses the same peer-to-peer engine as [`../serverless/walkie.html`](../serverless/walkie.html):
WebRTC voice, with the public Nostr network used to find other people. Nobody
runs a server. On top of that it adds things a web page can't do:

- **Global push-to-talk key.** Hold **F8** (or any key you pick) to talk, even
  while you're in another app or a game.
- **Runs in the tray.** Closing the window keeps you on the channel so you still
  hear people. Right-click the tray icon to quit.
- **Full speed in the background.** Audio and connections aren't slowed down
  while the app is hidden.

Desktop users and people using `walkie.html` in a browser (including phones, if
you host the file) are on the same network. They can join the same channel and
talk to each other.

## Run from source

```bash
npm install
npm start
```

`npm start` copies `../serverless/walkie.html` into `renderer/` and launches the
app. That HTML file is the only app code, so edit it there.

## Build installers

```bash
npm run dist
```

The installers land in `dist/`:

| Platform | Output |
|----------|--------|
| Windows  | `Walkie Setup x.y.z.exe` (installer) and `Walkie x.y.z.exe` (portable, no install) |
| macOS    | `.dmg` (build on a Mac) |
| Linux    | `.AppImage` |

Builds aren't code-signed, so Windows SmartScreen and macOS Gatekeeper will
warn the first time someone opens the app. To avoid that, sign the builds with
a certificate (see the electron-builder docs).

## Platform notes

- **macOS:** the global key needs *System Settings → Privacy & Security →
  Accessibility* permission for Walkie. The microphone permission prompt appears
  on first launch.
- **Linux:** the global key works on X11. Under Wayland, system-wide key hooks
  are blocked, so use the in-window button or Space instead.
- If the global key can't start, the app says so and the in-window button and
  Space still work.

## Files

| File | Purpose |
|------|---------|
| `main.js` | Window, tray, microphone permission, global key hook (`uiohook-napi`), settings |
| `preload.js` | The `window.walkieNative` bridge the page uses. The page has no Node.js access. |
| `icon.js` | Draws the app and tray icon in code (`node icon.js build/icon.png 512`) |
| `start.js` | Launches Electron with `ELECTRON_RUN_AS_NODE` cleared, which VS Code terminals can set |
| `renderer/walkie.html` | Copy of `../serverless/walkie.html`, refreshed by `npm run sync` |

Settings (talk key, keep running in tray) are stored in `settings.json` in the
app's user-data folder.

## Testing tips

To run two copies on one machine:

```bash
WALKIE_MULTI_INSTANCE=1 npm start
```

Each copy gets its own profile. Alternatively, run one desktop copy and open
`walkie.html` in a browser. Use headphones, or the two copies will feed back.
`WALKIE_FAKE_MEDIA=1` uses a fake test-tone microphone.
