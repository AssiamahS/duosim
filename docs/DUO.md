# The iPhone Duo

Verified against Xcode 27.1 / AXe 1.8.0 on an iPhone Duo (iOS 27.1).

A Duo exposes two panels, and they need different handling from every other
simulator. The short version:

```sh
UDID=<duo-udid> CAPTURE=simctl INPUT=duo npm run share
```

That serves `/outer` and `/inner` as independent pages, each streaming its own
panel and sending gestures to its own digitizer.

## Why those two flags are needed

**No AXe subsystem takes a `--display` flag**, and its two halves disagree about
which panel they mean:

| AXe subsystem | Always targets |
| --- | --- |
| `stream-video`, `screenshot` | **outer**, 1398x2034 (466x678 pt) |
| tap / swipe / touch / key (HID) | **outer**, 1398x2034 |
| `describe-ui` | whichever panel is active |

So AXe is an outer-panel-only tool, for both capture and input. With the Duo
unfolded and the inner panel lit, `axe stream-video` still returns 1398x2034
frames at 23 fps while `describe-ui` reports 669x951 pt — AXe hard-picks the
main surface, which is the outer one.

Hence:

- **`CAPTURE=simctl`** replaces `axe stream-video` with a loop of
  `xcrun simctl io screenshot --display`, the only capture path that can be
  aimed at a named panel, and therefore the only one that can serve both routes
  at once.
- **`INPUT=duo`** routes tap and swipe through `tools/duoinput`, which picks a
  panel by digitizer target. The server builds it from `tools/duoinput.m` on
  first run.

Text, keys and buttons stay on AXe either way: the keyboard service is not
per-panel.

Both flags turn on automatically as far as they can — `CAPTURE=simctl` is forced
whenever the device has two panels. `INPUT=duo` is not, so a Duo started without
it warns that taps on `/inner` will land on `/outer`.

## Identifying the panels

| Panel | Point size @3x | Pixels | Digitizer target | dtuhidd service |
| --- | --- | --- | --- | --- |
| outer | 678x466 | 1398x2034 | `1` | `mainTouchscreen(0x101)` |
| inner | 951x669 | 2007x2853 | `3` | `touchscreen(0x103)` |

The server finds them with `simctl io enumerate`, taking the ports with
`Display class: 0` and sorting by area — the smaller framebuffer is the outer
panel. Sorting by area rather than width matters, because a turned inner panel
is wider than the outer one.

**Do not identify panels by display UUID**: the guest's UUIDs regenerate on every
boot. `DISPLAY_UUID_OUTER` / `DISPLAY_UUID_INNER` override the choice for one run
if the heuristic ever picks wrong.

The digitizer `target` is the **low byte of the touchscreen's service ID**, and it
is a small enum, so passing a service ID instead is rejected outright — `dtuhidd`
answers `Cannot initialize DigitizerTarget from invalid UInt value 261` for
`0x105`. Override with `DUO_TARGET_OUTER` / `DUO_TARGET_INNER`.

## One input connection, held open

`dtuhidd` only dispatches a contact once it has consumed it, and drops whatever
is still in flight when the peer goes away — so a process per tap loses most of
them. Measured: **3/10 delivered** with a process per tap, **10/10** with one
connection held open.

`tools/duoinput` therefore holds a single digitizer connection for the life of
the server. The first gesture pays the activation handshake (~0.95s) and every
later one costs **~0.13s**.

That handshake is per-peer, which is why **both panels share one helper process**
rather than running one each. The server sends `target` and `rot` before a
gesture when either has changed, and serializes every gesture globally so a
switch cannot interleave with someone else's tap.

This is also what the "40–60% touch loss" seen through AXe comes down to. It
is not a delivery bug — the client disconnects before `dtuhidd` has consumed
the events.

## Gestures have to be turned

A gesture must be rotated before it reaches the digitizer, and by how much
depends on the device orientation:

| Device orientation | Rotation |
| --- | --- |
| `landscapeLeft` | 0 |
| `portrait` | 90 |
| `landscapeRight` | 180 |
| `portraitUpsideDown` | 270 |

All four were measured on the inner panel. The server reads the orientation from
`devicectl` (~0.1s, polled every 3s while anyone is watching, and again right
after a rotate) and looks the value up.

**Do not try to infer this from the frame.** Content renders upright in the
framebuffer whichever way the panel is turned, so two orientations needing
rotations 180° apart produce pixel-identical frames. An earlier version guessed
from the frame's aspect ratio and got half of them wrong, with no visible symptom
except gestures landing sideways.

The outer panel is orientation-locked, so a single value (0) covers it.
`DUO_ROT_OUTER` / `DUO_ROT_INNER` pin a fixed rotation if a pose turns up that
the table does not cover. See [ROTATION.md](ROTATION.md) for the full story.

## Only one panel is lit at a time

Folded, the outer panel is on and the inner framebuffer is solid black.
Unfolded, it is the other way round. Nothing in this project can wake the dark
panel — folding is what changes it, and only Device Hub's UI folds a Duo.
Nothing in `simctl`, `devicectl` or any preference file sets the pose, and a
`simctl`-booted Duo cannot be unfolded at all: the inner panel flashes empty and
collapses back, because Device Hub never initialised its framebuffer.

Both routes keep streaming either way. The dark one is recognised by JPEG density
(free, because the frames are in hand already), drops to a single worker polling
every `IDLE_POLL_MS`, and tells the page to say the panel is off rather than
showing a black rectangle and looking broken. Measured over 10s, one viewer each:

| Route | Frames | Data |
| --- | --- | --- |
| lit | 40 | 997 KiB (~100 KiB/s) |
| dark | 5 | 34 KiB (~3.4 KiB/s) |

It wakes on the first frame with content in it, so nothing needs restarting when
you fold the device.

`DARK_BYTES_PER_PX` is the threshold. There are two defaults because the figure
depends on how hard the frame was compressed: a scaled frame runs 0.0062 B/px
black against 0.0517 for a live app screen, and a full-resolution one 0.0162
against 0.1056. Each default sits between its own pair with about 2x of room
either side.

## Capture is the slow half

Input on both panels is solved. Capture is not.

| Step | Cost |
| --- | --- |
| `simctl io screenshot --display` (inner) | **0.43s** — dominant, mostly process startup |
| `ffmpeg` resize to `SCALE` | 0.05–0.17s |
| Full-resolution JPEG, unscaled | 335 KB |
| End to end through the WebSocket | **3.5 fps, 31 KB/frame** |

Three overlapping workers at ~2 fps each is the ceiling. The 0.43s `simctl` spawn
is the floor, so nothing on this path reaches 30 fps.

Everything else about this path is a consequence of the same thing:

- **It polls blindly.** No damage or dirty-rect detection, so a static screen
  costs the same as a moving one. `FPS` is a ceiling only — it cannot raise the
  rate, but `FPS=2` throttles the workers to stop the CPU burn.
- **It goes through the filesystem.** `simctl screenshot` will not write to
  stdout, so every frame is written to and read from a temp file.
- **It needs ffmpeg.** `simctl` has no scale or quality option, so `SCALE` and
  `QUALITY` are applied with `ffmpeg`. Without it frames go out at full
  resolution — roughly 370 KB each instead of 42 KB — and the server warns once.

### What would actually fix it

Read the display's `IOSurface` directly through SimulatorKit / CoreSimulator. No
window, no permission prompt, and it is what `idb video-stream` and
`axe stream-video` are already built on — **AXe just hard-picks the main (outer)
surface.** The per-display surfaces are visible already: `simctl io enumerate`
lists an `IOSurface port` for the inner panel alongside a
`com.apple.display.captureservice` port, and `tools/duoinput.m` demonstrates the
`dlopen` CoreSimulator pattern needed to reach them.

Two alternatives were ruled out with evidence:

- **`simctl io recordVideo --display`** works and accepts a fifo with `--force`
  (`Recording started`), but writes a **non-fragmented** QuickTime file — the
  index lands at the end, so `ffmpeg` fails live with `moov atom not found`. Not
  streamable.
- **Window capture of Device Hub** (ScreenCaptureKit) would give real 30–60 fps
  and the inner panel for free, but costs the Screen Recording permission and a
  real, visible, unobstructed window, and needs the simulator chrome cropped.
  That rules it out for a headless remote-streaming tool.

### Worth doing upstream

File an AXe issue for display selection, in capture and input, distinct from
[AXe#71](https://github.com/cameroncooke/AXe/issues/71). One `--display` flag
upstream would remove most of this file.
