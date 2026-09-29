# ios-sim-stream-share

Stream a booted iOS Simulator to a browser and drive it from there — taps,
swipes, typing and hardware buttons. One Node process, no build step, no
framework, one runtime dependency.

Useful for showing a running app to someone who is not at your Mac:
`npm run share` prints a public URL they can open on a phone or laptop.

It also handles the **iPhone Duo**, where the two panels need different capture
and input paths from every other simulator. That took real work; see
[docs/DUO.md](docs/DUO.md).

```
┌──────────┐   JPEG frames over WebSocket   ┌─────────┐
│ iOS      │ ─────────────────────────────▶ │         │
│ Simulator│                                │ browser │
│          │ ◀───────────────────────────── │         │
└──────────┘   tap / swipe / text as JSON   └─────────┘
      ▲                                          
      └── server.js: simctl + AXe + tools/duoinput
```

## Contents

| Document | What is in it |
| --- | --- |
| This file | install, run, controls, configuration, security |
| [docs/MULTI-SIM.md](docs/MULTI-SIM.md) | running several simulators from one Mac |
| [docs/DUO.md](docs/DUO.md) | iPhone Duo: two panels, which flags to set, what is slow |
| [docs/ROTATION.md](docs/ROTATION.md) | rotating the Duo, and why gestures must be turned to match |
| [docs/TUNNEL.md](docs/TUNNEL.md) | a stable public URL instead of a throwaway one |
| [tools/README.md](tools/README.md) | the helper binaries and the smoke test |

## Requirements

| Tool | Why | Install |
| --- | --- | --- |
| macOS + Xcode | there is no iOS Simulator anywhere else | — |
| Node 18+ | runs the server | `brew install node` |
| Xcode command line tools | finds and captures the simulator (`xcrun simctl`) | `xcode-select --install` |
| [AXe](https://github.com/cameroncooke/AXe) | input injection, and video on a single-screen device | `brew tap cameroncooke/axe && brew install axe` |
| ffmpeg | scales frames when capturing per display | `brew install ffmpeg` |
| cloudflared | only for `npm run share` | `brew install cloudflared` |

AXe drives the simulator through Apple's accessibility APIs, so the first run
may prompt for Accessibility permission — grant it to your terminal in
**System Settings → Privacy & Security → Accessibility**.

## Quickstart

Boot a simulator, then:

```sh
npm install
npm start          # local only
npm run share      # local + a public cloudflared URL
```

Both print a URL per panel, each carrying a one-time token:

```
[iPhone 17] Local:  http://localhost:8787/outer?t=6f1c…
[iPhone 17] Public: https://some-words.trycloudflare.com/outer?t=6f1c…
```

Open it, and the token moves into an `HttpOnly` cookie and disappears from the
address bar. Share the full URL **including** `?t=`; without it the server
returns 404.

To keep settings in a file instead of on the command line:

```sh
cp .env.example .env     # then edit it
node --env-file=.env server.js
```

## Controls

| Action | How |
| --- | --- |
| Tap | click / tap |
| Swipe, scroll | drag more than 10px — the duration matches how long you dragged |
| Type | **Keyboard** button, then type; paste works too |
| Return, Delete | toolbar buttons, or the real keys while **Keyboard** is active |
| Arrows, Esc, Tab | the real keys, while **Keyboard** is active |
| Home, Lock, Siri | toolbar buttons — **broken on Xcode 27.1**, see Limitations |
| Rotate the device | **↺ Rotate** / **Rotate ↻**, on `/inner` only ([docs/ROTATION.md](docs/ROTATION.md)) |

Keycodes (Return, Delete, arrows) need the simulator's hardware keyboard, because
`axe key` injects HID events that go nowhere without it. Turn it on with
**I/O → Keyboard → Connect Hardware Keyboard** (`⇧⌘K`), or:

```sh
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool true
```

then restart Simulator.app. Plain typing works either way — `axe type` does not
use the HID keyboard path. Only US-keyboard ASCII can be typed, which is a
limitation of `axe type`.

### One page per panel

Each panel has its own URL, listed top right so you can switch between them:
**`/outer`** and **`/inner`**, with `/` redirecting to `/outer`. They stream and
take input independently. A single-screen simulator only has `/outer`.

### Telling instances apart

Every page shows the simulator's name top right, next to a colour derived from
that name, and every log line is tagged with it:

```
[Duo A] inner: tap 0.5000 0.5000  [target 3 rot 90, device portrait]
```

The name defaults to the simulator's own (`iPhone 17`, `iPhone Duo`), and
`LABEL` overrides it when two devices share a name. This matters as soon as you
run more than one — see [docs/MULTI-SIM.md](docs/MULTI-SIM.md).

### Is anyone using it?

A badge top left answers that before you take over. It is shared: everyone
viewing either panel sees the same thing, because both drive one device. It goes
by the last **input**, not by who has a tab open, so a colleague reading the
screen does not show up as busy.

| | |
| --- | --- |
| 🟢 **Free** | no input for `FREE_MS` (10 min) |
| 🟡 **Likely free** | no input for `LIKELY_FREE_MS` (5 min) |
| 🔴 **Busy** | someone interacted more recently than that |

Hover it for the number of viewers across both panels. The server pushes the age
on every input and every 15s, and the page ages the label itself in between, so
it never sits stale.

### What it costs while nobody is watching

Three levels, so an abandoned tab is not the same as a closed one:

| State | What runs |
| --- | --- |
| no tab open on a panel | capture stops completely; the next connection restarts it |
| every tab on it backgrounded | one worker at `IDLE_POLL_MS`, resumes within ~0.5s on return |
| panel dark (folded away) | the same slow poll, and the page says the panel is off |

The middle one matters most in practice: a backgrounded tab keeps its WebSocket
open, so without the Page Visibility check a forgotten tab would stream at full
rate indefinitely. Measured with one viewer on one panel: 12 frames / 428 KiB
per 6s visible, against 6 frames / 214 KiB per 10s hidden.

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `HOST` | `127.0.0.1` | bind address — leave it on loopback and use a tunnel |
| `TOKEN` | random per run | fixed token, so the URL survives restarts |
| `UDID` | first booted sim | which simulator to attach to |
| `LABEL` | the simulator's name | what to call this instance in the page and the logs |
| `FPS` | `30` | frame rate ceiling (1–30) |
| `QUALITY` | `70` | JPEG quality (1–100) |
| `SCALE` | `0.5` | frame scale (0.1–1.0); lower is cheaper over a tunnel |
| `MAX_CLIENTS` | `4` | concurrent viewers, per panel |
| `CAPTURE` | `axe` | `simctl` captures a chosen display; forced on when the device has two panels |
| `INPUT` | `axe` | `duo` routes tap/swipe to a chosen panel via `tools/duoinput` |
| `AXE_HID_STABILIZATION_MS` | `500` | how long to hold each input process open on iOS 27 |
| `POINT_W`, `POINT_H` | from `axe describe-ui` | override the logical screen size |
| `DUO_TARGET_OUTER`, `DUO_TARGET_INNER` | `1`, `3` | digitizer target: low byte of the touchscreen service ID |
| `DUO_ROT_OUTER`, `DUO_ROT_INNER` | from the orientation table | pin the gesture rotation, ignoring the table |
| `DISPLAY_UUID_OUTER`, `DISPLAY_UUID_INNER` | smallest/largest class-0 display | which display each route grabs |
| `SHOT_WORKERS` | `3` | overlapping `simctl` screenshots in flight, per panel |
| `IDLE_POLL_MS` | `3000` | how often to check a panel that is dark or has no visible tab |
| `LOG_INPUT` | `1` | log every gesture with the rotation and orientation it used |
| `LIKELY_FREE_MS` | `300000` | no input for this long turns the badge yellow |
| `FREE_MS` | `600000` | no input for this long turns it green |
| `DARK_BYTES_PER_PX` | `0.015` scaled, `0.03` full-res | JPEG density below which a frame counts as black |

```sh
UDID=$(xcrun simctl list devices booted -j | jq -r '.devices[][0].udid') \
LABEL="Demo" TOKEN=dev FPS=20 SCALE=0.4 npm run share
```

## How it works

On a single-screen simulator, `axe stream-video --format raw` emits
`[4-byte big-endian length][JPEG]` repeatedly. The server de-frames that and
fans each JPEG out over a WebSocket.

On a device with two panels, AXe cannot aim at one, so the server falls back to
a loop of `xcrun simctl io screenshot --display`, resized by `ffmpeg`. That is
the only capture path that takes a display, and it is much slower —
see [docs/DUO.md](docs/DUO.md).

The client decodes with `createImageBitmap` and draws to a canvas, skipping any
frame that arrives while it is still decoding, so a slow viewer falls behind in
quality rather than in latency.

Input travels back as JSON with normalized `0..1` coordinates, replayed through
`axe tap` / `swipe` / `type` / `key` / `button`, or through `tools/duoinput`
when a specific panel has to be named.

## Verified behaviour and limitations

Tested against Xcode 27.1 / AXe 1.8.0, on an iPhone 17 (iOS 26.5) and an
iPhone Duo (iOS 27.1).

| Feature | Status |
| --- | --- |
| Video stream | works |
| Tap, swipe | works |
| Text entry (`axe type`) | works, US-keyboard ASCII only |
| Keycodes (Return, Delete, arrows) | works, needs the hardware keyboard connected |
| Home / Lock / Siri buttons | **broken on Xcode 27.1** (see below) |
| Tap / swipe on iOS 27 | works, via the stabilization window (see below) |
| iPhone Duo, both panels | works — `CAPTURE=simctl INPUT=duo`, see [docs/DUO.md](docs/DUO.md) |
| Video of the Duo's inner panel | works but slow, ~3.5 fps |

### Hardware buttons do not work on Xcode 27.1

`axe button home|lock|siri|side-button` reports success and does nothing, with
or without the stabilization window. Xcode 27.1's own Device Hub Home control is
broken in the same way, so this is below AXe. There is no workaround here; the
buttons are left in the UI because they will start working again when Apple
fixes it.

### iOS 27 needs a HID stabilization window (handled for you)

On Xcode 27, `dtuhidd` activates its virtual touch service only once it has a
peer, and drops anything sent before that. A short-lived `axe` process writes its
whole gesture into that gap and exits, so the tap is lost while `axe` still
prints `✓ … completed successfully` and exits 0 — a completely silent failure.
This is [cameroncooke/AXe#71](https://github.com/cameroncooke/AXe/issues/71).

The server works around it by holding every input process open past the
activation window, via `AXE_HID_STABILIZATION_MS` (default `500`). Without it,
neither tapping nor swiping works — no tap style helps, and `touch`, `drag` and
`gesture` fail the same way.

The real fix is upstream in `facebook/idb` (commit `7a9a2e10`, which primes a new
connection and waits for activation). AXe 1.8.0 pins an older fork revision that
predates it, so until AXe re-pins, the delay is the fix. Lower it if your machine
is quick and you want snappier input:

```sh
AXE_HID_STABILIZATION_MS=250 npm start
```

### `describe-ui` can report the wrong panel

It sometimes reports the outer panel's 466x678 while content is on the inner
panel. When that happens, pin the size with `POINT_W` / `POINT_H` so input
scaling stays correct.

## Development

After any change to `server.js`, run the smoke test against a running server:

```sh
TOKEN=<the running server's token> npm run smoke
```

It opens a WebSocket per panel, sends a gesture, and fails unless real frames
arrive and the process is still alive afterwards.

Worth the habit, because the obvious checks do not cover this: `node --check`
only parses, and `curl` only exercises the HTTP handler. A function reference
lost from the capture loop passes both, then throws the first time a browser
opens a socket and takes the process with it — which reaches a viewer as a
Cloudflare **502** with a healthy tunnel and nothing in the HTTP logs. If you see
that 502, check the server is still running before blaming Cloudflare.

## Security

Anyone with the URL can drive your simulator, so treat the token as a password
and stop the server when you are done. `trycloudflare.com` URLs are public to
anyone who has one.

### What a viewer can do

The reachable surface is one simulator, not the host. A client can send exactly
five messages, all scoped with `--udid` to the chosen device: `tap`, `swipe`,
`text`, `key`, `button`. Every subprocess is spawned with array arguments and no
shell, so no client value is ever interpolated into a command line, and
`duoinput` delivers touches over XPC to the guest rather than into the host event
stream. Capture is of the simulator display only.

What is genuinely exposed:

- Everything inside that simulator: signed-in accounts, app data, and the ability
  to drive or install apps.
- The simulator shares the host's network stack, so a viewer can reach your LAN
  and internal services from inside it. This is the real pivot.
- `server.js` is a host process reachable from the internet, so a bug in it would
  be host code execution. Attack surface, not granted capability.

### What is in place

- The token is compared with `timingSafeEqual`, and moved out of the URL into an
  `HttpOnly`, `SameSite=Strict` cookie on first load (`Secure` behind a tunnel).
- WebSocket upgrades require a matching `Origin`, which blocks cross-site
  WebSocket hijacking from a page that somehow learned the token.
- Input is rate-limited per connection (20/s, burst 40) and validated:
  coordinates must be `0..1`, keycodes `0..255`, button names from a fixed list,
  text capped at 500 ASCII characters.
- Frames over 16 MB are treated as a lost length prefix and the stream restarts,
  rather than growing the buffer without bound.
- Viewers are capped by `MAX_CLIENTS` per panel; capture only runs while someone
  is watching.

### What is deliberately not here

There is no per-user identity, no audit log, and no authorization beyond the
single shared token. Do not leave it running unattended. For a stable URL with
real identity in front of it, see [docs/TUNNEL.md](docs/TUNNEL.md).

## License

MIT — see [LICENSE](LICENSE).
