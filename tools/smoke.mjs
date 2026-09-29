// Does the server actually serve? Run it after any change to server.js.
//
// Why this exists: `node --check` only parses, and curl only exercises the HTTP
// handler. A missing function reference inside the capture loop passes both and
// then throws the first time a browser opens a WebSocket, killing the process -
// which reaches the outside world as a Cloudflare 502, with a healthy tunnel and
// nothing in the HTTP logs. This catches it in seconds.
//
//   TOKEN=<token> [PORT=8787] node tools/smoke.mjs
//
// Exits non-zero unless every panel opens a socket and delivers real frames.
import WebSocket from 'ws';

const PORT = process.env.PORT || 8787;
const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error('Set TOKEN to the server\'s token (it is printed in the server URL).');
  process.exit(2);
}

const origin = `http://localhost:${PORT}`;
const panels = (process.env.PANELS || 'outer,inner').split(',');
let failed = false;

const check = (name) => new Promise((done) => {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws/${name}`, {
    headers: { Origin: origin, Cookie: `sim_token=${TOKEN}` },
  });
  let frames = 0;
  ws.on('message', (d, isBinary) => { if (isBinary) frames++; });
  ws.on('error', (e) => { console.error(`${name}: socket error - ${e.message}`); failed = true; });
  // Drive the input path too; a throw in there is just as fatal and just as invisible.
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'visible', visible: true }));
    setTimeout(() => ws.send(JSON.stringify({
      type: 'swipe', x1: 0.5, y1: 0.6, x2: 0.5, y2: 0.4, duration: 0.3,
    })), 1200);
  });
  setTimeout(() => {
    if (frames) console.log(`${name}: ${frames} frames - ok`);
    else { console.error(`${name}: no frames`); failed = true; }
    try { ws.close(); } catch {}
    done();
  }, 8000);
});

await Promise.all(panels.map(check));

// A crash shows up as a dead process, not as a socket error, so check it landed.
try {
  const res = await fetch(`${origin}/${panels[0]}?t=${TOKEN}`);
  if (!res.ok) { console.error(`server not answering after the run (HTTP ${res.status})`); failed = true; }
  else console.log('server still up - ok');
} catch (e) {
  console.error(`server is gone after the run: ${e.message}`);
  failed = true;
}

process.exit(failed ? 1 : 0);
