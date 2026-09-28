import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';

const run = promisify(execFile);

const PORT = +(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.TOKEN || randomBytes(16).toString('hex');
const FPS = process.env.FPS || '30';
const QUALITY = process.env.QUALITY || '70';
const SCALE = process.env.SCALE || '0.5';
const MAX_CLIENTS = +(process.env.MAX_CLIENTS || 4);
const TUNNEL = process.argv.includes('--tunnel');

// Frames are independent JPEGs, so a slow client just skips some instead of queueing latency.
const MAX_BUFFERED = 512 * 1024;
// A frame this large means we've lost sync with the length prefix, not a real screenshot.
const MAX_FRAME = 16 * 1024 * 1024;
// Token bucket per connection: sustained rate, and how much burst we tolerate.
const INPUT_RATE = 20;
const INPUT_BURST = 40;
const MAX_TEXT = 500;
const BUTTONS = new Set(['home', 'lock', 'siri', 'side-button', 'apple-pay']);

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

async function preflight() {
  for (const [bin, hint] of [['xcrun', 'Install Xcode command line tools.'], ['axe', 'brew tap cameroncooke/axe && brew install axe']]) {
    try {
      await run('command', ['-v', bin], { shell: '/bin/sh' });
    } catch {
      fail(`Required command "${bin}" not found. ${hint}`);
    }
  }
}

async function resolveUdid() {
  if (process.env.UDID) return process.env.UDID;
  const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']);
  const booted = Object.values(JSON.parse(stdout).devices).flat();
  if (!booted.length) throw new Error('No booted simulator. Boot one or set UDID.');
  if (booted.length > 1) console.warn(`Multiple booted simulators, using "${booted[0].name}". Set UDID to pick another.`);
  return booted[0].udid;
}

await preflight();

let udid;
try {
  udid = await resolveUdid();
} catch (e) {
  fail(e.message);
}

// AXe input takes logical points; the root AX element (Application) spans the whole screen.
// Rotating the simulator changes this, so it is re-read whenever the client sees the frame
// aspect change rather than being measured once at startup.
let points = null;
let pointsStale = true;

async function readPointSize() {
  if (process.env.POINT_W && process.env.POINT_H) return { w: +process.env.POINT_W, h: +process.env.POINT_H };
  const { stdout } = await run('axe', ['describe-ui', '--udid', udid], { maxBuffer: 64 << 20 });
  const tree = JSON.parse(stdout);
  const frame = (Array.isArray(tree) ? tree[0] : tree)?.frame;
  if (!frame?.width || !frame?.height) throw new Error('Could not read screen size from describe-ui. Set POINT_W/POINT_H.');
  return { w: frame.width, h: frame.height };
}

async function ensurePoints() {
  if (!pointsStale && points) return points;
  const next = await readPointSize();
  if (!points || next.w !== points.w || next.h !== points.h) console.log(`Screen ${next.w}x${next.h} pt`);
  points = next;
  pointsStale = false;
  return points;
}

try {
  await ensurePoints();
} catch (e) {
  const msg = (e.stderr || e.message || '').trim();
  if (/translation object/i.test(msg)) {
    fail('The simulator is not ready yet (still booting, or showing a full-screen dialog).\n' +
         `Wait for it to reach the home screen, then retry:  xcrun simctl bootstatus ${udid} -b`);
  }
  fail(`Could not read the screen size:\n${msg}`);
}
console.log(`Simulator ${udid}`);

// ---------------------------------------------------------------- stream

const clients = new Set();
let streamProc = null;

function broadcast(frame) {
  for (const ws of clients) if (ws.bufferedAmount < MAX_BUFFERED) ws.send(frame);
}

function startStream() {
  if (streamProc) return;
  const p = spawn('axe', ['stream-video', '--format', 'raw', '--fps', FPS, '--quality', QUALITY, '--scale', SCALE, '--udid', udid], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  streamProc = p;

  // raw format: 4-byte BE length + JPEG, repeated.
  let buf = Buffer.alloc(0);
  p.stdout.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len > MAX_FRAME) {
        console.warn(`Frame length ${len} exceeds cap; resynchronising stream.`);
        buf = Buffer.alloc(0);
        stopStream();
        if (clients.size) setTimeout(startStream, 500);
        return;
      }
      if (buf.length < 4 + len) break;
      broadcast(buf.subarray(4, 4 + len));
      buf = buf.subarray(4 + len);
    }
  });

  let errTail = '';
  p.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });

  p.on('error', (e) => console.error('stream-video failed to start:', e.message));
  p.on('exit', (code, signal) => {
    if (streamProc !== p) return;
    streamProc = null;
    if (signal === 'SIGTERM') return;
    console.warn(`stream-video exited (${code ?? signal})\n${errTail.trim()}`);
    if (clients.size) setTimeout(startStream, 1000);
  });
}

function stopStream() {
  const p = streamProc;
  streamProc = null;
  p?.kill('SIGTERM');
}

// ---------------------------------------------------------------- input

function runStdin(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn('axe', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('exit', (code) => (code ? reject(new Error(err.trim() || `exit ${code}`)) : resolve()));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

// Serialized so inputs land in the order they were made.
let inputChain = Promise.resolve();
function enqueue(fn) {
  inputChain = inputChain.then(fn).catch((e) => console.error('input failed:', (e.stderr || e.message || '').trim()));
}

const norm = (v) => typeof v === 'number' && v >= 0 && v <= 1;
const pt = (v, extent) => (v * extent).toFixed(1);

function handleInput(m) {
  switch (m.type) {
    case 'tap':
      if (!norm(m.x) || !norm(m.y)) return;
      return enqueue(async () => {
        const s = await ensurePoints();
        await run('axe', ['tap', '-x', pt(m.x, s.w), '-y', pt(m.y, s.h), '--tap-style', 'physical', '--udid', udid]);
      });

    case 'swipe': {
      if (![m.x1, m.y1, m.x2, m.y2].every(norm)) return;
      const duration = Math.min(Math.max(+m.duration || 0.25, 0.05), 5);
      return enqueue(async () => {
        const s = await ensurePoints();
        await run('axe', ['swipe',
          '--start-x', pt(m.x1, s.w), '--start-y', pt(m.y1, s.h),
          '--end-x', pt(m.x2, s.w), '--end-y', pt(m.y2, s.h),
          '--duration', String(duration), '--udid', udid]);
      });
    }

    case 'text': {
      // axe type is US-keyboard only; drop anything it would reject outright.
      const text = String(m.text ?? '').slice(0, MAX_TEXT).replace(/[^\x20-\x7e\n\t]/g, '');
      if (!text) return;
      return enqueue(() => runStdin(['type', '--stdin', '--udid', udid], text));
    }

    case 'key': {
      const code = Number(m.code);
      if (!Number.isInteger(code) || code < 0 || code > 255) return;
      return enqueue(() => run('axe', ['key', String(code), '--udid', udid]));
    }

    case 'button':
      if (!BUTTONS.has(m.name)) return;
      return enqueue(() => run('axe', ['button', m.name, '--udid', udid]));

    case 'rotated':
      // Client hint only; describe-ui remains the authority on the new size.
      pointsStale = true;
      return;
  }
}

// ---------------------------------------------------------------- auth

const tokenBuf = Buffer.from(TOKEN);
function validToken(value) {
  if (typeof value !== 'string') return false;
  const given = Buffer.from(value);
  return given.length === tokenBuf.length && timingSafeEqual(given, tokenBuf);
}

function cookieToken(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'sim_token') return decodeURIComponent(v.join('='));
  }
  return null;
}

const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

// Blocks cross-site WebSocket hijacking: a hostile page holding the token still
// cannot open a socket, because its Origin will not match the host we are serving.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

const html = await readFile(new URL('./index.html', import.meta.url));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname !== '/') return res.writeHead(404).end();
  if (!validToken(url.searchParams.get('t')) && !validToken(cookieToken(req))) return res.writeHead(404).end();

  // Hand the browser a cookie so the token can leave the URL, where it would
  // otherwise sit in history, referrers and tunnel logs.
  const cookie = [
    `sim_token=${encodeURIComponent(TOKEN)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=86400',
    isHttps(req) ? 'Secure' : null,
  ].filter(Boolean).join('; ');

  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'set-cookie': cookie,
    'referrer-policy': 'no-referrer',
  });
  res.end(html);
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://local');
  if (url.pathname !== '/ws' || !sameOrigin(req) || !validToken(cookieToken(req))) return socket.destroy();
  if (clients.size >= MAX_CLIENTS) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', (ws) => {
  clients.add(ws);
  startStream();

  let tokens = INPUT_BURST;
  let last = Date.now();

  ws.on('message', (data, isBinary) => {
    if (isBinary || data.length > 4096) return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!m || typeof m.type !== 'string') return;

    const now = Date.now();
    tokens = Math.min(INPUT_BURST, tokens + ((now - last) / 1000) * INPUT_RATE);
    last = now;
    if (tokens < 1) return;
    tokens -= 1;

    handleInput(m);
  });

  ws.on('error', () => ws.close());
  ws.on('close', () => {
    clients.delete(ws);
    if (!clients.size) stopStream();
  });
});

// Tunnels drop idle websockets; a static screen may produce no frames.
setInterval(() => { for (const ws of clients) ws.ping(); }, 25_000).unref();

// ---------------------------------------------------------------- tunnel

let tunnel = null;
function startTunnel() {
  tunnel = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let announced = false;
  tunnel.stderr.on('data', (d) => {
    const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !announced) {
      announced = true;
      console.log(`Public: ${m[0]}/?t=${TOKEN}`);
    }
  });
  tunnel.on('error', (e) => console.error('cloudflared failed to start:', e.message, '(brew install cloudflared)'));
  tunnel.on('exit', (code) => { if (code) console.error(`cloudflared exited (${code})`); });
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') fail(`Port ${PORT} is already in use. Set PORT to something else.`);
  fail(`Server error: ${e.message}`);
});

server.listen(PORT, HOST, () => {
  console.log(`Local:  http://localhost:${PORT}/?t=${TOKEN}`);
  if (TUNNEL) startTunnel();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopStream();
    tunnel?.kill();
    process.exit(0);
  });
}
