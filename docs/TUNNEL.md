# A stable public URL

`npm run share` uses a **quick tunnel**:
`cloudflared tunnel --url http://localhost:8787`, which hands out a random
`*.trycloudflare.com` hostname. Cloudflare documents these as having no uptime
guarantee and no stable name — the URL changes on every restart. They are for a
quick look, not for anything someone else depends on.

The fix is a **named tunnel**. Same `cloudflared` binary, different mode: the
tunnel is a persistent object in your Cloudflare account with credentials on
disk, and you map hostnames in a zone you control to local ports.

This was set up and verified end to end; the measurements at the bottom are
real. The hostnames below are placeholders — substitute your own domain.

## Setup

You need a domain on Cloudflare. Only the first command needs a browser.

```sh
# 1. Authorize. Opens a browser; pick the zone. Writes ~/.cloudflared/cert.pem.
cloudflared tunnel login

# 2. Create the tunnel. Writes ~/.cloudflared/<TUNNEL-UUID>.json (the credentials).
cloudflared tunnel create sim-share
cloudflared tunnel list                  # note the UUID

# 3. Point hostnames at it. One DNS record per simulator.
cloudflared tunnel route dns sim-share sim-a.example.com
cloudflared tunnel route dns sim-share sim-b.example.com

# 4. After writing config.yml below:
cloudflared tunnel ingress validate
```

**One tunnel serves every simulator** — you do not need a second tunnel for the
second simulator. `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /Users/<you>/.cloudflared/<TUNNEL-UUID>.json

ingress:
  - hostname: sim-a.example.com
    service: http://localhost:8787
  - hostname: sim-b.example.com
    service: http://localhost:8788
  # Required last rule: anything else gets a 404 instead of reaching your Mac.
  - service: http_status:404
```

Keep it at mode 600. Then:

```sh
cloudflared tunnel run sim-share
```

WebSockets need no configuration; `cloudflared` proxies the upgrade as-is. The
server's 25-second keepalive ping already covers Cloudflare's idle-websocket
timeout, which is what that ping was added for.

Start the servers with fixed tokens, so the whole URL is stable across restarts:

```sh
LABEL="Sim A" UDID=<udid-a> PORT=8787 TOKEN=<token-a> npm start
LABEL="Sim B" UDID=<udid-b> PORT=8788 TOKEN=<token-b> npm start
```

Use `npm start`, **not** `npm run share` — `share` passes `--tunnel` and would
spawn a competing quick tunnel. Keep `HOST` on `127.0.0.1`; the tunnel reaches
loopback and nothing needs to be exposed on your LAN.

Each hostname then serves a page per panel:
`https://sim-a.example.com/outer?t=…` and `…/inner?t=…`. The bare
`https://sim-a.example.com/?t=…` redirects to `/outer`, setting the cookie on the
way, so an older single-panel link still works. No tunnel or DNS change is
needed for the panel routes: the paths sit behind the same hostname.

## Keep it running

Run this **without `sudo`**, from anywhere — it is a launchd user agent, not
anything scoped to the project directory:

```sh
cloudflared service install          # no sudo
launchctl list | grep cloudflared    # confirm loaded
```

`cloudflared` branches on euid, and the difference matters:

| | Installs to | Runs as | Reads config from |
| --- | --- | --- | --- |
| no `sudo` | `~/Library/LaunchAgents/` | you, at login | `~/.cloudflared/config.yml` |
| `sudo` | `/Library/LaunchDaemons/` | root, at boot | `/var/root/.cloudflared/` or `/etc/cloudflared/` |

Under `sudo` it installs cleanly and then fails to find the tunnel, because the
credentials and config live in your home directory. (Copying them to
`/etc/cloudflared` is the Linux/systemd behaviour, not macOS.)

A user agent is also the right lifecycle match: simulators need a logged-in GUI
session, so a boot-time root daemon would come up with nothing to serve.

This manages the **tunnel only**. The simulators and the Node servers are not
under launchd, so after a login the hostnames resolve and return 502 until you
boot the simulators and start the servers. True unattended operation would need
its own launch agents — and it is worth deciding whether you want a
remote-control endpoint for a simulator coming up by itself.

## Put real auth in front of it

Worth doing at the same time, because a stable URL is a much better target than
a random one that dies in an hour. The shared token is the only thing in front
of it, and there is no identity and no audit log.

What is at risk is scoped to the simulator, not the Mac — see
"What a viewer can do" in the [README](../README.md). That is still worth
protecting: the accounts and app data inside the simulator, and the fact that
the simulator shares your Mac's network stack, so a viewer can reach your LAN
from inside it.

Cloudflare Access (Zero Trust → Access → Applications → Self-hosted) puts an
identity check in front of the hostname before the request reaches your Mac. It
is free for small teams, and a one-time-PIN policy against your own email is
enough. It layers cleanly on what is already there: the `CF_Authorization`
cookie rides along with the WebSocket handshake, and the stable hostname keeps
the server's `Origin` check working.

## Measured through a named tunnel

With one Duo on `CAPTURE=simctl INPUT=duo`:

- `GET /` with no token, or a wrong token → `404`. With the right token → `200`,
  and the cookie comes back `Secure` — the server correctly detects it is behind
  a tunnel.
- WebSocket upgrade through the proxy succeeds and frames flow: **2.9 fps,
  94 KiB/s** public against **3.4 fps, 110 KiB/s** on `localhost` from the same
  server. The tunnel costs roughly 15%, and the ~3 fps ceiling is the
  `CAPTURE=simctl` screenshot path, not Cloudflare. If you want more frames,
  that is where to look.

### Three ways a 502 is not a broken tunnel

This is the one thing that will waste your time, so it gets its own list.

- **A WebSocket with a bad token surfaces as `502`, not `401`.** That is
  `server.js` calling `socket.destroy()` on failed auth, and `cloudflared`
  reporting the dropped connection as a bad gateway. It is a rejection working
  as intended.
- **No server on that port returns `502`.** Expected when only one simulator is
  running.
- **A crashed server looks identical from outside** — healthy tunnel,
  Cloudflare's diagnostic page showing "Host: Error". Check
  `pgrep -f "node server.js"` before suspecting Cloudflare, and see
  "Development" in the README for the smoke test that catches this class of
  crash before you deploy.

## Caveats

- **Cloudflare's terms restrict serving a disproportionate amount of non-HTML
  content through the CDN on free plans**, aimed at video. This streams JPEG
  frames over a WebSocket, which is proxied and not cached, so it is not what
  that clause targets — but it is sustained video-ish traffic through
  Cloudflare, and how they would read it at volume is not something this
  document can promise. Low `FPS` / `SCALE` / `QUALITY` help with both bandwidth
  and this.
- **Latency.** Traffic goes to a Cloudflare edge and back rather than direct.
  Fine for driving a UI, noticeable next to a LAN connection.

## Alternatives

- **Tailscale Funnel** — public HTTPS on a stable
  `<machine>.<tailnet>.ts.net` hostname, no domain needed, one command
  (`tailscale funnel 8787`). Fewer moving parts than a named tunnel.
- **Tailscale without Funnel** — if the viewers are you and your teammates
  rather than the public, put them on the tailnet and skip public exposure
  entirely. Lowest latency of the three and by far the smallest attack surface.
  This is the right default for a team demo.
