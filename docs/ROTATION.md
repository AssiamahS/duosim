# Rotating the Duo

Working: the page has Rotate buttons and they turn the device. Getting there
needed an unpleasant route, and the caveats below are worth reading before you
trust what you see.

Verified on an iPhone Duo, iOS 27.1, Xcode 27.1, Apple Silicon.

## The short version

Nothing in the simulator toolchain rotates a Duo. The only thing that does is
Device Hub's own rotate command, and its menu bar is unreachable over
Accessibility — so `tools/duorotate` sends it the keyboard equivalent
(`Cmd+←` / `Cmd+→`) instead. `server.js` exposes that as a `rotate` message, and
the page has a button per direction.

```sh
tools/duorotate [left|right]      # default: left
```

It needs Accessibility **and** Automation → System Events for whatever runs the
server. The script prints which grant is missing.

## What each route actually does

| Route | Reaches the guest? | Rotates the panel? |
| --- | --- | --- |
| `baguette orientation` (GSEvent → `backboardd`) | yes — 4 requests, 4 correct events | **no** |
| `devicectl device orientation get` | — | read works; tracks the real state |
| `devicectl device orientation set` / `rotate` | **no events at all** | **no** — reports success, does nothing |
| `baguette hinge` (drives `devicectl` internally) | yes — full `CMMagicPoseEvent` | n/a — folds, and works |
| Device Hub menu item over Accessibility | — | **unreachable**, see below |
| Device Hub `Cmd+←/→` via System Events | yes — `locationd` → `CMMagicPose` | **yes** |

The Duo tracks **per-surface orientations**, driven by CoreMotion via
`locationd`, not the legacy GSEvent path:

```
locationd    Orientation set to: 4 (landscape-right)
SpringBoard  CMMagicPoseEvent deviceOrientation:LandscapeRight
                              deviceOrientation0:LandscapeLeft   <- cover
                              deviceOrientation1:LandscapeRight  <- inner
                              hingeState:OpenFlat
SpringBoard  CMMagicPose surface orientation changed: cover Po -> Ll, inner Po -> Lr
```

`baguette orientation` delivers a correct single GSEvent to `backboardd` — the
guest logs `Got an orientation event from a GSEvent: 1|2|3|4`, correctly mapped
— but SpringBoard drives the surfaces from `CMMagicPose`, so it is ignored.
`CoreSimulator` has no orientation strings at all; this is not a simctl-level
concept.

**Device Hub's menu bar cannot be scripted.** The tidy route would be
`click menu item "Rotate Left" …`. It is not available: System Events resolves
the process but reads almost nothing off it — `role`, `title` and `position` all
come back `missing value`, `unix id` is `0`, and `menu bar 1` fails with
**-1719 (invalid index)**. This is not a missing TCC grant; Finder's menu bar
reads fine from the same terminal with the same permissions. Hence the keyboard
equivalent.

## The two costs of this route

Both are inherent, not bugs to be fixed here.

- **Device Hub must be running, and becomes frontmost.** A keystroke goes to the
  focused app, so rotating from the web page steals host focus for a moment.
- **It rotates whichever surface Device Hub is showing**, not a surface you can
  name. The server can neither choose that surface nor read back which one it is.

That second one is the weak point of the whole arrangement. The Rotate buttons
on `/outer` and `/inner` send the same command and land wherever Device Hub is
pointed; switch Device Hub's display and the same button starts rotating the
other panel. The buttons are therefore offered on `/inner` only, since the outer
panel is orientation-locked and rotating from there mostly just steals focus.

The feedback is misleading in both directions:

- **The outer panel honours the app's orientation lock.** A portrait-only app
  looks identical before and after a rotation that really did land there. Do not
  read "nothing moved" as "the rotation went to the other panel".
- **The inner panel ignores the lock entirely**, so that is where a rotation is
  actually visible, and the only panel where it changes the layout an app has to
  cope with.
- `devicectl device orientation get` reports the surface Device Hub is showing,
  which is the same surface the rotate hits — so it confirms *a* rotation
  happened, not which panel it happened to.

## Rotation and input

A rotation changes the digitizer mapping, and **the frame cannot tell you what
it is**. Content renders upright in the framebuffer whichever way the panel is
turned, so two orientations needing rotations 180° apart produce pixel-identical
frames. The stream looks perfectly correct while gestures land somewhere else —
the most confusing failure mode in this project.

Two earlier attempts here got it wrong in opposite directions. The first assumed
the mapping was constant — measured while the inner panel was dark, and a panel
that is off never turns. The second inferred it from the frame's aspect ratio,
which was worse, because it looked right half the time.

All four values were measured on the inner panel, by swiping a list repeatedly
until it pinned and seeing which end it pinned at. A rotation that scrolls the
list the way the gesture implies pins at the bottom; one that is 180° out pins
at the top:

| Device orientation | Rotation | How it was confirmed |
| --- | --- | --- |
| `landscapeLeft` | **0** | pinned at the bottom |
| `portrait` | **90** | 270 pinned at the top, so 270 is inverted |
| `landscapeRight` | **180** | 0 was reported exactly inverted |
| `portraitUpsideDown` | **270** | predicted by the cycle, then confirmed in use |

They come out one quarter turn apart in rotation order, which is the sanity
check: four orientations, four distinct quarter turns, each rotate-left
subtracting 90. Anything that does not fit that pattern is a bad measurement.

The orientation comes from `devicectl device orientation get` — about 0.1s warm,
polled every 3s while anyone is watching and again right after a rotate. Because
it reports the surface Device Hub is showing rather than the panel being driven,
it is used **only as a lookup key** and never as a formula. `DUO_ROT_OUTER` /
`DUO_ROT_INNER` pin a fixed value if a pose appears that the table does not
cover.

The outer panel's rotation is measured in one pose only (folded, 0). It is
orientation-locked in a portrait-only app, so it should not need the table — but
an app that allows landscape on the cover panel would be worth re-measuring.

### Nothing else can substitute for reading the orientation

- **The frame's aspect ratio.** See above; it splits the four into two pairs and
  cannot separate either pair.
- **`axe describe-ui`.** Reports 669x951 regardless.
- **The guest's `CMMagicPose` log** does carry per-surface orientation in
  principle, but had nothing to read when queried with `log show`. It is
  event-driven and per-panel, so it is the better source if anyone wants to take
  this further.

## Capture and input must name the same panel

Otherwise every gesture silently lands on the screen you are not watching. The
server pairs them per route:

| Route | Display | Digitizer target |
| --- | --- | --- |
| `/outer` | the 1398x2034 panel | `1` — `mainTouchscreen(0x101)` |
| `/inner` | the 2007x2853 panel | `3` — `touchscreen(0x103)` |

Both routes share **one** `duoinput` process: the `dtuhidd` activation window
that causes touch loss is per-peer, so a second helper would pay it again and
drop contacts. See [DUO.md](DUO.md).

## Instruments that lie

Two of these cost real time. Do not trust them here.

- **`axe describe-ui` reports 669x951 even after a confirmed rotation.** An
  earlier conclusion of "it never rotates, measured" rested on this and was
  wrong. Verify by eye, by `devicectl … orientation get`, or by the
  `CMMagicPose` log line — not by point size.
- **`devicectl device orientation set|rotate` prints `New Device Orientation: …`
  and does nothing.** Two consecutive `rotate left` calls both printed
  `landscapeLeft`, and `get` kept returning the old value.

Two more red herrings, for completeness:

- **`UISupportedInterfaceOrientations` is irrelevant on the inner display**,
  which ignores it entirely — a portrait-only app gets landscape there. Do not go
  looking in the app's Info.plist.
- **Settings rendering a two-column split view is not evidence of rotation.**
  The inner panel is wide, so that is size-class layout.

## There is no "rotate view" control

Content arrives upright in the framebuffer, so there is nothing to straighten.
Gesture mapping is handled server-side from the table above.
