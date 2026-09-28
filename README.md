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
| Home / Lock / Siri buttons | did not work in this environment |

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

### Input does not work on iOS 27 simulators

On Xcode 27.1, AXe drives iOS 27 simulators through Device Hub, and that input
path silently discards everything. Every AXe input command - `tap` (all three tap
styles), `touch`, `drag`, `swipe`, `gesture` and `tap --label` - prints
`✓ ... completed successfully` while not a single pixel changes.

It is not a coordinate problem and not this tool's doing:

- `describe-ui` and `stream-video` work correctly against the same simulator, so
  AXe is talking to the device.
- `simctl launch` redraws 97% of the screen, so the simulator is healthy.
- The same AXe binary, at the same moment, taps fine on an iOS 26.5 simulator
  (80.7% of the screen changed).
- Xcode 27.1's own Device Hub Home button is broken too, which is the same path.

AXe 1.8.0 documents validation against Xcode 27 **Beta 3** (`27A5218g`) and iOS
`24A5380g`. Xcode 27.1 (`27A9269`) and iOS `24A94401` are both newer, and the
Device Hub input path appears to have changed under it.

The server prints a warning at startup when it detects an iOS 27+ simulator, so
the failure is visible rather than silent. **Use an iOS 26 simulator if you need
to interact**; iOS 27 gives you a view-only session.

### Foldables (iPhone Duo): view-only either way

An iPhone Duo exposes two framebuffers and AXe is hard-wired to the larger one
(2007x2853 = 669x951 pt), which is the **inner** screen. What works depends on
the fold pose, and input never does:

| Pose | Active screen | Video | Input |
| --- | --- | --- | --- |
| Folded | outer (1398x2034 = 466x678 pt) | black feed | does not land |
| Unfolded | inner (2007x2853 = 669x951 pt) | works | does not land |

Unfolded, `describe-ui` and `stream-video` agree and you get a real picture, so
the Duo is usable as a read-only viewer. But taps never register: tapping an
element at coordinates taken from AXe's own `describe-ui` output prints
`✓ Tap at (160.0, 218.3) completed successfully` while not a single pixel
changes. Both `--tap-style physical` and `simulator` behave the same, and the
same applies to swipes. The simulator itself is fine - `simctl launch` and
`simctl ui appearance` both redraw the screen normally.

There is no `--display` flag on any AXe command, so none of this is
configurable. Use a non-folding simulator if you need to drive the UI.

Check which screen is live with:

```sh
xcrun simctl io <udid> screenshot --display=1 /tmp/d1.png   # outer
xcrun simctl io <udid> screenshot --display=3 /tmp/d3.png   # inner
```

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
