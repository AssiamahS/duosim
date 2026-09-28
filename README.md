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
| Return, Delete | toolbar buttons, or the real keys while Keyboard is active (needs hardware keyboard) |
| Arrows, Esc, Tab | keyboard, while Keyboard is active |
| Home, Lock, Siri | toolbar buttons (see Limitations — often non-functional) |

Rotating the simulator is picked up automatically: the client notices the frame
aspect flip and the server re-reads the screen size before the next input.

Only US-keyboard ASCII can be typed — that is a limitation of `axe type`.

## Verified behaviour and limitations

Tested against Xcode 27.1 / AXe 1.8.0 on an iPhone 17 (iOS 26.5) simulator:

| Feature | Status |
| --- | --- |
| Video stream | works — real frames at the configured scale |
| Tap | works |
| Swipe / scroll | works |
| Text entry (`axe type`) | works |
| Keycodes (Return, Delete, arrows) | needs the hardware keyboard connected |
| Home / Lock / Siri buttons | broken on Xcode 27.1 (see below) |
| Tap / swipe on iOS 27 | works via the stabilization window (see below) |

**Keycodes need the simulator's hardware keyboard.** `axe key` injects HID events,
which go nowhere if the keyboard is disconnected. Turn it on with
**I/O → Keyboard → Connect Hardware Keyboard** (`⇧⌘K`), or:

```sh
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool true
```

then restart Simulator.app. Plain typing works either way, because `axe type`
does not go through the HID keyboard path.

**Hardware buttons may not work at all.** On Xcode 27.1 the Device Hub's own Home
control is broken, and `axe button` fails the same way for every button type —
it reports success and nothing happens. This is not something this tool can fix.

### iOS 27 needs a HID stabilization window (handled for you)

On Xcode 27, `dtuhidd` activates its virtual touch service only once it has a peer
and drops anything sent before that. A short-lived `axe` process writes its whole
gesture into that gap and exits, so the tap is lost while `axe` still prints
`✓ ... completed successfully` and exits 0 - a completely silent failure.
This is [cameroncooke/AXe#71](https://github.com/cameroncooke/AXe/issues/71).

The server works around it by holding every input process open past the activation
window, via `AXE_HID_STABILIZATION_MS` (default `500`). With it, tapping and
swiping work on iOS 27. Without it, neither does - no tap style helps, and
`touch`, `drag` and `gesture` fail the same way.

The real fix is upstream in `facebook/idb` (commit `7a9a2e10`, which primes a new
connection and waits for activation). AXe 1.8.0 pins an older fork revision that
predates it, so until AXe re-pins, the delay is the fix.

Lower it if your machine is quick and you want snappier input:

```sh
AXE_HID_STABILIZATION_MS=250 npm start
```

### Hardware buttons do not work on Xcode 27.1

`axe button home|lock|siri|side-button` reports success and does nothing, with or
without the stabilization window. Xcode 27.1's own Device Hub Home control is
broken in the same way, so this is below AXe. There is no workaround here.

### Foldables (iPhone Duo)

A Duo exposes two framebuffers and AXe is hard-wired to the larger one
(2007x2853 = 669x951 pt), the **inner** screen. The fold pose therefore decides
whether you see anything:

| Pose | Active screen | Video | Tap / swipe |
| --- | --- | --- | --- |
| Folded | outer (466x678 pt) | black feed | no |
| Unfolded | inner (669x951 pt) | works | works |

So keep the Duo **unfolded**. `describe-ui` follows the active display correctly,
so the point size is right either way, but `stream-video` has no `--display` flag
and only ever captures the inner screen.

## Running more than one simulator

Each instance needs its own port and its own simulator; `--tunnel` then gives
each one a separate public URL:

```sh
UDID=<iphone-udid> PORT=8787 npm run share
UDID=<duo-udid>    PORT=8788 npm run share
```

Without `UDID` the server picks the first booted simulator, which is ambiguous
once several are running, so set it explicitly.

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
| `AXE_HID_STABILIZATION_MS` | `500` | how long to hold each input process open on iOS 27 |

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
