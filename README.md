# sim-share

Stream a booted iOS Simulator to a browser, and drive it from there — taps, swipes,
typing and hardware buttons. One Node process, no build step, no framework.

Useful for showing a running app to someone who isn't at your Mac: `npm run share`
prints a public URL they can open on a phone or laptop.

## Requirements

| Tool | Why | Install |
| --- | --- | --- |
| Node 18+ | runs the server | `brew install node` |
| Xcode command line tools | finds the booted simulator (`xcrun simctl`) | `xcode-select --install` |
| [AXe](https://github.com/cameroncooke/AXe) | video stream and input injection | `brew tap cameroncooke/axe && brew install axe` |
| cloudflared | only for `npm run share` | `brew install cloudflared` |

AXe drives the simulator through Apple's accessibility APIs, so the first run may
prompt for Accessibility permission — grant it to your terminal in
**System Settings → Privacy & Security → Accessibility**.

## Usage

```sh
npm install
npm start          # local only
npm run share      # local + public cloudflared URL
```

Both print a URL containing a one-time token:

```
Local:  http://localhost:8787/?t=6f1c…
Public: https://some-words.trycloudflare.com/?t=6f1c…
```

Open it, and the token moves into an `HttpOnly` cookie and disappears from the
address bar. Share the full URL *including* `?t=`; without it the server returns 404.

## Controls

| Action | Gesture |
| --- | --- |
| Tap | click / tap |
| Swipe, scroll | drag (>10px) — duration matches how long you dragged |
| Type | **Keyboard** button, then type; paste works too |
| Return, Delete | toolbar buttons, or the real keys while Keyboard is active |
| Arrows, Esc, Tab | keyboard, while Keyboard is active |
| Home, Lock, Siri | toolbar buttons |

Rotating the simulator is picked up automatically: the client notices the frame
aspect flip and the server re-reads the screen size before the next input.

Only US-keyboard ASCII can be typed — that is a limitation of `axe type`.

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `HOST` | `127.0.0.1` | bind address — leave it on loopback and use the tunnel |
| `TOKEN` | random per run | fixed token, so the URL survives restarts |
| `UDID` | first booted sim | which simulator to attach to |
| `FPS` | `30` | stream frame rate (1–30) |
| `QUALITY` | `70` | JPEG quality (1–100) |
| `SCALE` | `0.5` | frame scale (0.1–1.0); lower is cheaper over a tunnel |
| `MAX_CLIENTS` | `4` | concurrent viewers |
| `POINT_W`, `POINT_H` | read from `axe describe-ui` | override the logical screen size |

```sh
UDID=$(xcrun simctl list devices booted -j | jq -r '.devices[][0].udid') \
TOKEN=dev FPS=20 SCALE=0.4 npm run share
```

## How it works

`axe stream-video --format raw` emits `[4-byte big-endian length][JPEG]` repeatedly.
The server de-frames that and fans each JPEG out over a WebSocket; the client decodes
with `createImageBitmap` and draws to a canvas, skipping any frame that arrives while
it is still decoding, so a slow viewer falls behind in quality rather than in latency.
Input travels back as JSON with normalized `0..1` coordinates, which the server scales
to points and replays through `axe tap` / `axe swipe` / `axe type` / `axe key`.

## Security

This is a remote-control endpoint for your Mac. Anyone with the URL can drive your
simulator, so treat the token as a password and stop the server when you're done —
`trycloudflare.com` URLs are public to anyone who has one.

What's in place:

- The token is compared with `timingSafeEqual`, and moved out of the URL into an
  `HttpOnly`, `SameSite=Strict` cookie on first load (`Secure` behind the tunnel).
- WebSocket upgrades require a matching `Origin`, which blocks cross-site WebSocket
  hijacking from a page that somehow learned the token.
- Input is rate-limited per connection (20/s, burst 40) and validated: coordinates
  must be `0..1`, keycodes `0..255`, button names from a fixed list, text capped at
  500 ASCII characters.
- Frames over 16 MB are treated as a lost length prefix and the stream restarts,
  rather than growing the buffer without bound.
- Viewers are capped by `MAX_CLIENTS`; the stream only runs while someone is watching.

What's deliberately *not* here: there is no per-user identity, no audit log, and no
authorization beyond the single shared token. Don't leave it running unattended.
