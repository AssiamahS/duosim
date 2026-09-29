# tools

Everything here is used by `server.js` or by you directly. Nothing needs
installing; `duoinput` is compiled on first run.

| File | What it is |
| --- | --- |
| `duoinput.m` | The input helper for foldables. Holds one digitizer connection and reads gestures on stdin, so a tap costs no process spawn and the `dtuhidd` activation handshake is paid once. `server.js` builds and starts it when `INPUT=duo`. |
| `duorotate` | Rotates the device by sending Device Hub its own `Cmd+←` / `Cmd+→` shortcut. The only thing that turns a Duo. |
| `run-sims.mjs` | Starts one server per entry in `sims.json`. See [../docs/MULTI-SIM.md](../docs/MULTI-SIM.md). |
| `smoke.mjs` | Post-change check against a running server. |

## duoinput

```sh
clang -fobjc-arc -framework Foundation -o duoinput duoinput.m
./duoinput <udid> <target> [--rot 0|90|180|270]
```

`target` is the low byte of the touchscreen's service ID: `1` for the outer
panel, `3` for the inner one. `--rot` carries interface coordinates back into
panel space. It then reads one command per line on stdin and answers one line
each:

```
tap X Y                       # normalized 0..1, in panel space
swipe X1 Y1 X2 Y2 MS
target N                      # aim at another panel
rot 0|90|180|270
```

The server drives it, so you rarely need this directly — but it is the thing to
run by hand when taps are not landing. See [../docs/DUO.md](../docs/DUO.md).

## duorotate

```sh
./duorotate [left|right]      # default: left
```

Needs Accessibility **and** Automation → System Events for whatever runs it; it
prints which grant is missing. Device Hub must be running, and is brought to the
front. See [../docs/ROTATION.md](../docs/ROTATION.md).

## smoke.mjs

```sh
TOKEN=<the running server's token> [PORT=8787] node tools/smoke.mjs
```

Opens a WebSocket per panel against a running server, sends a gesture, and fails
unless real frames arrive and the process survives. Run it after any change to
`server.js`: `node --check` and `curl` both miss a crash that only fires once
something connects.

## Verifying input by hand

Ground truth for "did that tap land" is the guest log, never a tool's exit code
— `axe` prints `completed successfully` for events that are silently discarded:

```sh
xcrun simctl spawn <udid> log stream --style compact \
  --predicate 'subsystem == "com.apple.BackBoard"'
```

`presence: touching` means the contact arrived; `dispatchMode: sending` versus
`ignoring` says whether it actually reached the app.

Touch delivery **through AXe** is 40–60% lossy, so repeat every AXe check 5–10
times and judge the aggregate. Through `duoinput` it is not lossy — that loss
was the client dropping the XPC connection before `dtuhidd` had consumed the
events.
