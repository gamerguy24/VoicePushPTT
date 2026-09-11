# Walkie (serverless) — one file, no server

`walkie.html` is the whole app. Nobody runs a server for it. Send the file to
people or put it anywhere that serves static files. Anyone in the world who
opens it and enters the same channel can talk.

## Use it

1. Open `walkie.html` in Chrome, Edge, Firefox or Safari. Double-clicking the
   file is fine.
2. Enter your name and a channel. Pick an unusual channel name, because anyone
   who types the same name joins you.
3. Optional: set a channel password. Everyone on the channel has to use the
   same one.
4. Hold the big button (or <kbd>Space</kbd>) to talk.

### Getting it to other people

- **Send the file.** Email it, put it in a shared drive or chat, or pass it
  on a USB stick. They open it and join the same channel. This is the easiest
  way on desktop.
- **Phones:** mobile browsers can't really open local HTML files, so put
  the file on any free static host: GitHub Pages, Netlify Drop (drag the file
  in), Cloudflare Pages and so on. That's just file hosting, with no backend
  to run or pay for. Then send people
  `https://your-site/walkie.html?channel=your-channel`. The **Invite** button
  copies that link.

The microphone only works on a secure page. A local file and `https://` are
both fine; a plain `http://` address on your network is not.

## How it works without a server

WebRTC always needs a way for two browsers to swap connection details before
they can talk (this step is called *signaling*). Here that goes through the
public **Nostr** relay network, using the bundled
[Trystero](https://github.com/dmotz/trystero) library (MIT):

```
  Alice ──(encrypted connection offer)──►  public Nostr relays  ◄──(answer)── Bob
  Alice ◄══════════ direct WebRTC: voice (Opus) + control messages ══════════► Bob
```

- The relays only see encrypted connection setup messages. Setting a channel
  password makes the key depend on that password too.
- Voice and push-to-talk messages go directly between browsers and are always
  encrypted.
- **Who holds the channel** is decided without a server. Pressing talk
  broadcasts a timestamped claim. If two people press at nearly the same time,
  every browser picks the same winner (earliest timestamp, then peer ID), and
  the other person hears a busy tone.

## Map

The radio screen has a satellite map (MapTiler `satellite-v4`, drawn with
MapLibre GL).

- **Share my location** uses the device's GPS or location service. It's off by
  default.
- **Set on map**: click the map to place yourself by hand. Use this when there's
  no GPS or the location permission is denied, which is common on desktop.
- **Show all** zooms to fit everyone who's sharing. Click a pin or a 📍 name in
  the member list to fly to that person.
- A pin **pulses while that person is talking**.
- Locations go directly between peers on the same encrypted WebRTC link as the
  voice, never through the Nostr relays. Updates are limited to one every 3
  seconds, and anyone who joins later gets your position straight away.

**About the MapTiler key:** the key is in `walkie.html` (`MAP_STYLE`), so anyone
with the file can read it. In the MapTiler dashboard, set usage limits for it,
and allowed origins if you host the page. A local file sends no origin, so an
origin-restricted key stops the map working for people who open the file
directly. In that case, host the page, or keep a separate unrestricted key with
low usage limits.

## Limits

- **Channel size:** everyone connects to everyone, which works well for about
  8–10 people.
- **Some networks block direct connections:** about 10–20% of connections
  (strict corporate firewalls, some mobile carriers) need a TURN relay.
  Under *Advanced* on the join screen, enter a TURN server. Cloudflare and
  Open Relay (metered.ca) both have free tiers.
- **Needs the public network:** it depends on public Nostr relays being
  reachable. The app connects to several at once for redundancy, and the
  status line shows how many are connected.
- **No history:** nothing is recorded, so people only hear what's said
  while they're on the channel.

## Updating the bundled library

Trystero 0.25.4 is inlined in the first `<script>` block. To update it:

```bash
npm i @trystero-p2p/nostr esbuild
echo "export { joinRoom, selfId, getRelaySockets } from '@trystero-p2p/nostr'" > entry.js
npx esbuild entry.js --bundle --format=iife --global-name=Trystero --minify --outfile=trystero.iife.js
```

Then replace the contents of that script block with `trystero.iife.js`.
