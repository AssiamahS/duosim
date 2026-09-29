# Running several simulators from one Mac

Each server instance drives exactly one simulator. Running more is a matter of
giving each one its own port, its own device and its own token.

## Telling them apart

Two instances render the same page, so without a name the only difference in a
browser is the port number. The server therefore carries a label everywhere:

- in the tab title — `Inner — Duo A`
- in the page header, top right, next to a colour derived from the name
- on every log line — `[Duo A] inner: tap 0.5000 0.5000 …`

It defaults to the simulator's own name from `simctl`, so most setups need no
configuration. Set `LABEL` when two devices share a name, or when you want
something shorter than `iPhone 17 Pro Max`.

The colour is a hash of the label. It is stable across restarts and needs no
configuring, and its only job is to make two tabs distinguishable at a glance.

## By hand

```sh
LABEL="iPhone" UDID=<iphone-udid> PORT=8787 TOKEN=<token-a> npm run share
LABEL="Duo"    UDID=<duo-udid>    PORT=8788 TOKEN=<token-b> npm run share
```

Two rules, both of which fail quietly if broken:

- **Always set `UDID`.** Without it the server picks the first booted simulator,
  which is ambiguous the moment a second one exists — it will silently attach to
  the wrong device.
- **Give each instance its own `TOKEN`.** A shared token would let a viewer of
  one simulator drive the other.

## From a config file

`tools/run-sims.mjs` starts one server per entry and stops them all together:

```sh
cp sims.example.json sims.json     # then fill in your UDIDs
npm run sims                       # or: node tools/run-sims.mjs other.json
```

```json
{
  "sims": [
    {
      "label": "Duo A",
      "udid": "…",
      "port": 8787,
      "tunnel": false,
      "env": { "CAPTURE": "simctl", "INPUT": "duo", "FPS": "10", "SCALE": "0.4" }
    }
  ]
}
```

| Key | Meaning |
| --- | --- |
| `label` | sets `LABEL`; omit to use the simulator's own name |
| `udid` | which simulator; omit only if you are running exactly one |
| `port` | sets `PORT` |
| `tunnel` | `true` passes `--tunnel`, for a public `trycloudflare.com` URL |
| `env` | any other environment variable from the README's configuration table |

It refuses to start if two entries share a port or a UDID, because both of those
fail in ways you would not notice: a duplicate port loses one instance to
`EADDRINUSE`, and a duplicate UDID gives you two pages driving one device.

Children inherit the terminal, and each server tags its own output, so the
interleaved logs stay readable. Ctrl-C stops everything. If any one server dies,
the launcher stops the rest rather than leaving a half-running set.

`sims.json` is gitignored — it holds your UDIDs and tokens.

## Duplicating a device

`simctl` will clone an existing simulator, including its apps and data, or
create a fresh one of the same type:

```sh
# Copy an existing device. `clone` refuses to run against a booted one.
xcrun simctl shutdown <udid>
xcrun simctl clone <udid> "Duo B"

# Or make a fresh one.
xcrun simctl list runtimes            # pick the runtime identifier
xcrun simctl create "Duo B" com.apple.CoreSimulator.SimDeviceType.iPhone-Duo <runtime-id>
```

Each device gets its own UDID and they boot concurrently. Verified on
Xcode 27.x with the `iPhone Duo` device type.

## What to check before relying on two Duos

Two things are untested, and they are the parts most likely to break.

- **Inner-panel input from two instances at once.** `INPUT=duo` works by holding
  an XPC connection open to `dtuhidd`. Whether two processes can hold connections
  to two different Duos simultaneously, or whether the second steals the first's
  activation window, has not been tested. This is the same failure shape as the
  silent-drop bug on iOS 27: the tool reports success while the events go
  nowhere. Test by tapping both simulators alternately and watching each guest's
  `backboardd` log, not the tool's exit code:

  ```sh
  xcrun simctl spawn <udid> log stream --style compact \
    --predicate 'subsystem == "com.apple.BackBoard"'
  ```

  `presence: touching` means the contact arrived; `dispatchMode: sending` versus
  `ignoring` says whether it reached the app.

- **Cost.** Each Duo renders two displays, and the per-display capture path costs
  two process spawns per frame. Two Duos plus two capture pipelines is a real
  load. Expect to trade frame rate or resolution — set `FPS` and `SCALE` per
  instance rather than letting both starve.

For one stable public hostname per instance instead of two throwaway
`trycloudflare.com` URLs, see [TUNNEL.md](TUNNEL.md).
