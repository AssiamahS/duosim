import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { readFile, unlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
// On Xcode 27 dtuhidd activates its virtual touch service only once it has a peer,
// and drops anything sent before that. A short-lived `axe` process writes its whole
// gesture into that gap and exits, so the tap is silently lost (cameroncooke/AXe#71).
// Holding each input process open past the activation window makes them land.
const HID_STABILIZATION_MS = process.env.AXE_HID_STABILIZATION_MS || '500';
const TUNNEL = process.argv.includes('--tunnel');
// `axe stream-video` and `axe screenshot` always capture the inner framebuffer and
// AXe's touch injection always targets the outer display, so on a foldable they
// point at opposite panels. CAPTURE=simctl swaps in a per-display screenshot loop,
// which is the only capture path that can be aimed at a panel by name - and so the
// only one that can serve /outer and /inner at the same time.
const CAPTURE = process.env.CAPTURE || 'axe';
// Input on a foldable. AXe's digitizer always drives the OUTER panel, so its
// tap/swipe never reach the inner screen no matter the coordinates. INPUT=duo
// routes them through tools/duoinput instead, which picks a panel with the
// digitizer `target` - the low byte of the touchscreen's service ID.
// Text, keys and buttons stay on AXe: the keyboard service is not per-panel.
const INPUT = process.env.INPUT || 'axe';
// A folded Duo lights one panel and leaves the other's framebuffer solid black,
// so the route facing away streams nothing anyone wants at full price. A dark
// panel drops to a single worker polling this often, and wakes on the first
// frame with content in it.
const IDLE_POLL_MS = Math.max(250, +(process.env.IDLE_POLL_MS || 3000));
// JPEG bytes per pixel, the cheap way to tell "solid black" from "a screen".
// The figure depends on how hard the frame was compressed, so there are two:
// measured on this Duo, a SCALE/QUALITY frame runs 0.0062 black against 0.0517
// for a live app screen, and a full-resolution one 0.0162 against 0.1056. Each
// default sits between its own pair with about 2x of room either side.
const DARK_SCALED = 0.015;
const DARK_FULL = 0.03;
let darkPerPx = +(process.env.DARK_BYTES_PER_PX || DARK_SCALED);
// One dark frame can just be a transition, so wait for a couple in a row before
// backing off. Waking is immediate: a single frame with content in it is enough.
const DARK_STREAK = 2;
// "Is anyone using the simulator right now?" - answered from the last input of
// any kind, shared by every viewer of both panels, since they drive one device.
const LIKELY_FREE_MS = +(process.env.LIKELY_FREE_MS || 5 * 60_000);
const FREE_MS = +(process.env.FREE_MS || 10 * 60_000);
// How often to re-send the age so the badge moves on its own between inputs.
const ACTIVITY_TICK_MS = 15_000;
let orientation = 'unknown';
// Print every gesture with the rotation it was sent under. On by default while
// the rotation table is still being worked out; LOG_INPUT=0 quiets it.
const LOG_INPUT = process.env.LOG_INPUT !== '0';
// How many screenshots to keep in flight per panel. Each `simctl io screenshot`
// costs ~0.4s, most of it process startup, so overlapping them buys the frame rate.
const SHOT_WORKERS = Math.max(1, Math.min(6, +(process.env.SHOT_WORKERS || 3)));
// ffmpeg's -q:v runs 2 (best) to 31 (worst), the opposite direction to QUALITY.
const jpegQ = Math.max(2, Math.min(31, Math.round(31 - (+QUALITY / 100) * 29)));

// Frames are independent JPEGs, so a slow client just skips some instead of queueing latency.
const MAX_BUFFERED = 512 * 1024;
// A frame this large means we've lost sync with the length prefix, not a real screenshot.
const MAX_FRAME = 16 * 1024 * 1024;
// Token bucket per connection: sustained rate, and how much burst we tolerate.
const INPUT_RATE = 20;
const INPUT_BURST = 40;
const MAX_TEXT = 500;
const BUTTONS = new Set(['home', 'lock', 'siri', 'side-button', 'apple-pay']);

// The Duo's two panels, smallest framebuffer first. The digitizer target is the
// low byte of the touchscreen's service ID (1 = mainTouchscreen(0x101) outer,
// 3 = touchscreen(0x103) inner).
//
// How far a gesture has to be turned to reach the digitizer, per device
// orientation. Measured on the inner panel by scrolling a list and seeing which
// end it pinned at: landscapeLeft 0, portrait 90, landscapeRight 180. They come
// out one quarter turn apart in rotation order, so portraitUpsideDown is 270 -
// four orientations, four distinct quarter turns, nothing left to choose.
//
// Nothing in the frame itself can stand in for this. Content renders upright in
// the framebuffer whichever way the panel is turned, so two orientations needing
// rotations 180 apart produce pixel-identical frames; an earlier version guessed
// from the frame's aspect and got half of them wrong.
const INNER_ROT = {
  landscapeLeft: 0,
  portrait: 90,
  landscapeRight: 180,
  portraitUpsideDown: 270,
};

// `canRotate`: the outer panel honours the app's orientation lock, so rotating
// from there usually does nothing visible and only steals host focus. The
// buttons are offered on the inner panel, which actually turns.
// `rotBy`: the outer panel is locked, so its gestures do not turn with the
// device and a single value covers it - measured 0 with the Duo folded.
const PANEL_DEFS = [
  { name: 'outer', label: 'Outer', target: '1', rot: '0', rotBy: null, canRotate: false },
  { name: 'inner', label: 'Inner', target: '3', rot: '0', rotBy: INNER_ROT, canRotate: true },
];

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

// ---------------------------------------------------------------- identity

// The simulator's own name and runtime, read once. `simctl` groups devices by
// runtime, so the key we find the UDID under is the runtime it is booted on.
async function describeDevice() {
  try {
    const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', '-j']);
    for (const [runtime, list] of Object.entries(JSON.parse(stdout).devices)) {
      const found = list.find((d) => d.udid === udid);
      if (found) return { name: found.name, runtime, major: +(/iOS-(\d+)/.exec(runtime)?.[1] ?? 0) };
    }
  } catch { /* naming is a convenience; the server runs fine without it */ }
  return { name: '', runtime: '', major: 0 };
}

const device = await describeDevice();

// What to call this instance. Two servers on one Mac are otherwise
// indistinguishable in a browser - same page, same panels, only the port
// differs - so the name goes in the tab title, the page header and every log
// line. It defaults to the simulator's own name, which is already unique per
// device, and `LABEL` overrides it when two devices share a name.
const LABEL = (process.env.LABEL || device.name || `sim :${PORT}`).slice(0, 40);

// Everything below is tagged, so several instances can share one terminal.
const log = (...a) => console.log(`[${LABEL}]`, ...a);
const warn = (...a) => console.warn(`[${LABEL}]`, ...a);
const logErr = (...a) => console.error(`[${LABEL}]`, ...a);

// ---------------------------------------------------------------- panels

// `simctl io enumerate` lists every port; the panels are the ones with
// `Display class: 0`. On a Duo there are two, and the narrower framebuffer is the
// outer/cover panel (1398x2034 against the inner 2007x2853). A non-foldable has
// one, and then only `outer` exists.
async function enumeratePanels() {
  const { stdout } = await run('xcrun', ['simctl', 'io', udid, 'enumerate'], { maxBuffer: 16 << 20 });
  const found = [];
  let uuid = null, klass = null, w = null;
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(UUID|Display class|Default width|Default height):\s*(\S+)/);
    if (!m) continue;
    if (m[1] === 'UUID') { uuid = m[2]; klass = w = null; }
    else if (m[1] === 'Display class') klass = +m[2];
    else if (m[1] === 'Default width') w = +m[2];
    else if (m[1] === 'Default height' && klass === 0 && uuid) found.push({ uuid, w, h: +m[2] });
  }
  // By area: a turned inner panel is wider than the outer one, so width alone
  // would swap them.
  return found.sort((a, b) => a.w * a.h - b.w * b.h);
}

const upper = (name) => name.toUpperCase();

async function buildPanels() {
  const displays = await enumeratePanels();
  if (!displays.length) throw new Error('No displays with "Display class: 0". Set DISPLAY_UUID_OUTER by hand.');

  return PANEL_DEFS.slice(0, displays.length).map((def, i) => ({
    ...def,
    display: process.env[`DISPLAY_UUID_${upper(def.name)}`] || displays[i].uuid,
    px: `${displays[i].w}x${displays[i].h}`,
    target: process.env[`DUO_TARGET_${upper(def.name)}`] || def.target,
    // Setting DUO_ROT_<PANEL> pins the rotation and ignores the table, which is
    // the escape hatch if a pose turns up that the measurements above do not cover.
    rotFixed: process.env[`DUO_ROT_${upper(def.name)}`] || null,
    rot: def.rot,
    clients: new Set(),
    stream: null,
    // Whether this panel's framebuffer is currently solid black, and how many
    // dark frames have arrived in a row.
    dark: false,
    darkStreak: 0,
  }));
}

let panels;
try {
  panels = await buildPanels();
} catch (e) {
  fail(`Could not enumerate the simulator's displays:\n${(e.message || '').trim()}`);
}
const byName = new Map(panels.map((p) => [p.name, p]));

// AXe input takes logical points; the root AX element (Application) spans the whole
// screen. Only the INPUT=axe path needs this, and AXe only ever sees one panel, so
// it is read lazily and a failure is not fatal - /inner does not depend on it.
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
  if (!points || next.w !== points.w || next.h !== points.h) log(`Screen ${next.w}x${next.h} pt`);
  points = next;
  pointsStale = false;
  return points;
}

// `com.apple.CoreSimulator.SimRuntime.iOS-27-1` reads better as `iOS 27.1`:
// the first dash separates the platform, the rest are version parts.
const runtimeName = device.runtime
  .replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, '')
  .replace(/-/, ' ')
  .replace(/-/g, '.');
log(`${udid}${runtimeName ? `  ${runtimeName}` : ''}`);
for (const p of panels) log(`  /${p.name.padEnd(5)} display ${p.display} ${p.px}px  digitizer target ${p.target}`);
// iOS 27 needs the dtuhidd stabilization window above, so say which one is in use.
if (device.major >= 27) log(`iOS ${device.major}: holding input ${HID_STABILIZATION_MS}ms for dtuhidd (AXE_HID_STABILIZATION_MS).`);

// ---------------------------------------------------------------- stream

let resize = false;

// Width and height out of a JPEG's SOF marker, used to judge how densely a frame
// compressed. The frames are in hand already, so this costs nothing.
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    // Standalone markers carry no length; everything else does.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    // SOF0..SOF15, minus DHT (c4), JPG (c8) and DAC (cc), which are not frame headers.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

// A panel is worth full frame rate only if its framebuffer has something on it
// AND somebody is actually looking. A backgrounded tab keeps its socket open, so
// without the visibility half a forgotten tab would stream at full price
// forever. Zero clients is handled separately: the loop stops outright.
function panelIdle(panel) {
  if (panel.dark) return true;
  for (const ws of panel.clients) if (ws.visible) return false;
  return true;
}

// Tell the page the panel went dark or came back, so it can say so instead of
// showing a black rectangle and looking broken.
function announce(panel) {
  const msg = JSON.stringify({ type: 'panel', dark: panel.dark });
  for (const ws of panel.clients) if (ws.readyState === ws.OPEN) ws.send(msg);
}

function noteFrameDark(panel, frame, size) {
  const dark = frame.length / (size.w * size.h) < darkPerPx;
  if (dark) {
    if (panel.dark) return;
    if (++panel.darkStreak < DARK_STREAK) return;
    panel.dark = true;
    log(`${panel.name}: framebuffer is dark, polling every ${IDLE_POLL_MS}ms until it lights up`);
    return announce(panel);
  }
  panel.darkStreak = 0;
  if (!panel.dark) return;
  panel.dark = false;
  log(`${panel.name}: framebuffer lit, back to full rate`);
  announce(panel);
}

function broadcast(panel, frame) {
  const size = jpegSize(frame);
  if (size) noteFrameDark(panel, frame, size);
  for (const ws of panel.clients) if (ws.bufferedAmount < MAX_BUFFERED) ws.send(frame);
}

// One screenshot per invocation, overlapped SHOT_WORKERS deep. Slower than
// `axe stream-video`, but it is the only capture that takes a --display, and so
// the only one that can run for both panels at once.
function startShotLoop(panel) {
  if (panel.stream) return;
  const session = { stopped: false };
  panel.stream = session;
  const display = panel.display;
  let warned = false;

  const worker = async (slot) => {
    const raw = join(tmpdir(), `sim-share-${process.pid}-${panel.name}-${slot}.jpg`);
    const small = join(tmpdir(), `sim-share-${process.pid}-${panel.name}-${slot}-s.jpg`);
    while (!session.stopped && panel.clients.size) {
      const began = Date.now();
      // While the panel is dark, or every tab on it is backgrounded, one worker
      // keeps watch and the rest stand down.
      if (panelIdle(panel) && slot !== 0) {
        await new Promise((r) => setTimeout(r, Math.min(IDLE_POLL_MS, 500)));
        continue;
      }
      try {
        await run('xcrun', ['simctl', 'io', udid, 'screenshot', '--display', display, '--type', 'jpeg', raw]);
        if (session.stopped) break;
        // simctl writes a full-resolution frame with no scale or quality control,
        // which is far too big for a tunnel, so honour SCALE/QUALITY via ffmpeg.
        let out = raw;
        if (resize) {
          await run('ffmpeg', ['-loglevel', 'error', '-i', raw, '-vf', `scale=iw*${SCALE}:-1`, '-q:v', String(jpegQ), '-f', 'mjpeg', small, '-y']);
          out = small;
        }
        broadcast(panel, await readFile(out));
      } catch (e) {
        if (!warned) { warned = true; warn(`${panel.name}: screenshot capture failed: ${(e.stderr || e.message || '').trim()}`); }
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      // Without this the workers spin flat out, so a static screen costs as much
      // as a moving one. Each worker takes its share of the overall FPS budget,
      // except while idle, when the one remaining worker just polls slowly.
      const budget = panelIdle(panel) ? IDLE_POLL_MS : SHOT_WORKERS * (1000 / +FPS);
      const spare = budget - (Date.now() - began);
      if (spare > 0) await new Promise((r) => setTimeout(r, spare));
    }
    await Promise.all([unlink(raw).catch(() => {}), unlink(small).catch(() => {})]);
  };

  for (let i = 0; i < SHOT_WORKERS; i++) worker(i);
}

// AXe's own stream, kept for non-foldables. It cannot be aimed at a panel, so it
// is only ever used when there is exactly one.
function startAxeStream(panel) {
  if (panel.stream) return;
  const p = spawn('axe', ['stream-video', '--format', 'raw', '--fps', FPS, '--quality', QUALITY, '--scale', SCALE, '--udid', udid], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  panel.stream = p;

  // raw format: 4-byte BE length + JPEG, repeated.
  let buf = Buffer.alloc(0);
  p.stdout.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (len > MAX_FRAME) {
        warn(`Frame length ${len} exceeds cap; resynchronising stream.`);
        buf = Buffer.alloc(0);
        stopStream(panel);
        if (panel.clients.size) setTimeout(() => startStream(panel), 500);
        return;
      }
      if (buf.length < 4 + len) break;
      broadcast(panel, buf.subarray(4, 4 + len));
      buf = buf.subarray(4 + len);
    }
  });

  let errTail = '';
  p.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });

  p.on('error', (e) => logErr('stream-video failed to start:', e.message));
  p.on('exit', (code, signal) => {
    if (panel.stream !== p) return;
    panel.stream = null;
    if (signal === 'SIGTERM') return;
    warn(`stream-video exited (${code ?? signal})\n${errTail.trim()}`);
    if (panel.clients.size) setTimeout(() => startStream(panel), 1000);
  });
}

// Two panels can only be served by the per-display path, so it is forced there.
const perDisplayCapture = CAPTURE === 'simctl' || panels.length > 1;

function startStream(panel) {
  return perDisplayCapture ? startShotLoop(panel) : startAxeStream(panel);
}

function stopStream(panel) {
  const p = panel.stream;
  panel.stream = null;
  if (!p) return;
  // The screenshot loop is a plain session object; its workers exit on the flag.
  if (p.stopped === false) p.stopped = true;
  else p.kill?.('SIGTERM');
}

// ---------------------------------------------------------------- input

// Every `axe` input invocation inherits the stabilization window.
const inputEnv = { ...process.env, AXE_HID_STABILIZATION_MS: HID_STABILIZATION_MS };
const runInput = (args) => run('axe', args, { env: inputEnv });

function runStdin(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn('axe', args, { stdio: ['pipe', 'ignore', 'pipe'], env: inputEnv });
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    p.on('error', reject);
    p.on('exit', (code) => (code ? reject(new Error(err.trim() || `exit ${code}`)) : resolve()));
    p.stdin.on('error', () => {});
    p.stdin.end(input);
  });
}

// One global chain, not one per panel: gestures for the two panels share a single
// duoinput connection and are separated by a `target` switch, so they must not
// interleave.
let inputChain = Promise.resolve();
function enqueue(fn) {
  inputChain = inputChain.then(fn).catch((e) => logErr('input failed:', (e.stderr || e.message || '').trim()));
}

// ---- duoinput: one long-lived digitizer connection -------------------------
// dtuhidd only dispatches a contact once it has consumed it, and drops whatever is
// still in flight when the peer goes away - so a process-per-tap loses most of them.
// One helper holds the connection for the run and pays the activation handshake once
// (~0.9s on the first gesture, ~0.13s each after). That handshake is per-peer, which
// is why both panels share this one process and switch its `target` instead of
// running one helper each.
const duoSrc = new URL('./tools/duoinput.m', import.meta.url).pathname;
const duoBin = new URL('./tools/duoinput', import.meta.url).pathname;
let duo = null;

async function buildDuo() {
  try {
    const [src, bin] = await Promise.all([stat(duoSrc), stat(duoBin).catch(() => null)]);
    if (bin && bin.mtimeMs >= src.mtimeMs) return;
  } catch {
    throw new Error(`missing ${duoSrc}`);
  }
  await run('clang', ['-fobjc-arc', '-framework', 'Foundation', '-o', duoBin, duoSrc]);
  log('Built tools/duoinput');
}

async function startDuo() {
  await buildDuo();
  const first = panels[0];
  const p = spawn(duoBin, [udid, first.target, '--rot', first.rot], { stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { proc: p, pending: [], ready: null, target: first.target, rot: first.rot };
  let out = '';
  p.stdout.on('data', (d) => {
    out += d;
    let i;
    while ((i = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, i).trim();
      out = out.slice(i + 1);
      if (state.ready) state.pending.shift()?.resolve(line);
      else { state.ready = line; state.readyResolve?.(line); }
    }
  });
  p.stderr.on('data', (d) => logErr('duoinput:', String(d).trim()));
  const done = (err) => {
    if (duo === state) duo = null;
    for (const w of state.pending.splice(0)) w.reject(err);
    state.readyReject?.(err);
  };
  p.on('error', (e) => done(e));
  p.on('exit', (code, signal) => done(new Error(`duoinput exited (${code ?? signal})`)));

  const hello = await new Promise((resolve, reject) => {
    state.readyResolve = resolve;
    state.readyReject = reject;
    setTimeout(() => reject(new Error('duoinput did not start within 10s')), 10_000).unref?.();
  });
  if (hello.startsWith('err')) throw new Error(`duoinput: ${hello}`);
  log(`Panel input via duoinput (${hello})`);
  duo = state;
  return state;
}

function duoSend(state, line) {
  return new Promise((resolve, reject) => {
    state.pending.push({ resolve, reject });
    state.proc.stdin.write(line + '\n', (e) => e && reject(e));
  }).then((reply) => {
    if (reply.startsWith('err')) throw new Error(`duoinput: ${reply}`);
  });
}

// ---- which way round the gestures go -------------------------------------
// The device orientation is read from `devicectl`. It reports the surface Device
// Hub is showing rather than the panel being driven, which is why it is only
// ever used as a lookup key and never as a formula.
function panelRot(panel) {
  if (panel.rotFixed !== null) return Number(panel.rotFixed);
  // Number, not string: the fallback comes from config as text, and arithmetic
  // on it elsewhere would concatenate.
  return Number(panel.rotBy?.[orientation] ?? panel.rot);
}

// Only worth reading while somebody is looking; also read right after a rotate,
// which is the case that would otherwise wait for the next tick.
async function readOrientation() {
  try {
    const { stdout } = await run('xcrun', ['devicectl', 'device', 'orientation', 'get', '--device', udid]);
    const next = /Current Device Orientation:\s*(\S+)/.exec(stdout)?.[1];
    if (!next || next === orientation) return;
    orientation = next;
    for (const p of panels) {
      const known = p.rotBy === null || p.rotBy[orientation] !== undefined || p.rotFixed !== null;
      log(`${p.name}: device now ${orientation}, gestures at ${panelRot(p)}` +
                  `${known ? '' : ' (orientation not in the table - set DUO_ROT_' + upper(p.name) + ' if gestures come out wrong)'}`);
    }
  } catch { /* devicectl is a convenience here, not a dependency */ }
}

function pollOrientation() {
  if (panels.some((p) => [...p.clients].some((ws) => ws.visible))) readOrientation();
}

// Aim the shared connection at this panel, then run the gesture. Each switch is
// skipped when it would be a no-op, so single-panel use costs nothing extra.
async function duoCmd(panel, line) {
  const state = duo ?? (await startDuo());
  const rot = String(panelRot(panel));
  if (state.target !== panel.target) {
    await duoSend(state, `target ${panel.target}`);
    state.target = panel.target;
  }
  if (state.rot !== rot) {
    await duoSend(state, `rot ${rot}`);
    state.rot = rot;
  }
  if (LOG_INPUT) {
    log(`${panel.name}: ${line}  [target ${panel.target} rot ${rot}` +
                `, device ${orientation}]`);
  }
  await duoSend(state, line);
}

// ---- device rotation ------------------------------------------------------
// Nothing scriptable turns the Duo: `devicectl device orientation set` is a stub
// against the simulator and `baguette orientation`'s GSEvent is ignored, because
// SpringBoard drives the surfaces from CMMagicPose. Device Hub's own command is
// the only route, so tools/duorotate sends it that keyboard shortcut - which
// means Device Hub comes to the front on the host.
//
// It rotates whichever surface Device Hub is SHOWING, which this server can
// neither choose nor read back. So a rotate from /inner turns the inner panel
// only if Device Hub happens to be displaying it. See docs/ROTATION.md.
const rotateBin = new URL('./tools/duorotate', import.meta.url).pathname;

async function rotateDevice(panel, dir) {
  const { stdout } = await run(rotateBin, [dir]);
  // Both framebuffers keep their pixel size through a rotation, so nothing in the
  // frame marks that one happened. The digitizer mapping follows the orientation,
  // so it is the orientation read below that matters; the point size AXe reports
  // turns with it too, hence the invalidation.
  pointsStale = true;
  log(`rotate ${dir} from /${panel.name} (applied to Device Hub's current surface): ${stdout.trim()}`);
  // The orientation just changed, so pick up the rotation that goes with it.
  setTimeout(readOrientation, 1200).unref?.();
}

// ---- who is using the simulator ------------------------------------------

let lastInputAt = null;

function activityMessage() {
  return JSON.stringify({
    type: 'activity',
    ageMs: lastInputAt === null ? null : Date.now() - lastInputAt,
    viewers: panels.reduce((n, p) => n + p.clients.size, 0),
    // Sent rather than duplicated in the page, so LIKELY_FREE_MS/FREE_MS take
    // effect without the two drifting apart.
    likelyMs: LIKELY_FREE_MS,
    freeMs: FREE_MS,
  });
}

function sendActivity() {
  const msg = activityMessage();
  for (const p of panels) for (const ws of p.clients) if (ws.readyState === ws.OPEN) ws.send(msg);
}

// Anything that drives the device counts. The client's own `rotated` hint and
// its visibility reports do not - nobody touched the simulator for those.
function noteActivity() {
  lastInputAt = Date.now();
  sendActivity();
}

// The badge ages on its own between inputs, so it has to be pushed on a timer
// as well as on change.
setInterval(sendActivity, ACTIVITY_TICK_MS).unref();

const norm = (v) => typeof v === 'number' && v >= 0 && v <= 1;
const pt = (v, extent) => (v * extent).toFixed(1);

const DRIVES_DEVICE = new Set(['tap', 'swipe', 'text', 'key', 'button', 'rotate']);

function handleInput(panel, m, ws) {
  if (DRIVES_DEVICE.has(m.type)) noteActivity();

  switch (m.type) {
    case 'visible':
      // Page Visibility, so a backgrounded tab stops costing full frame rate.
      ws.visible = m.visible !== false;
      return;

    case 'tap':
      if (!norm(m.x) || !norm(m.y)) return;
      if (INPUT === 'duo') return enqueue(() => duoCmd(panel, `tap ${m.x.toFixed(4)} ${m.y.toFixed(4)}`));
      return enqueue(async () => {
        const s = await ensurePoints();
        await runInput(['tap', '-x', pt(m.x, s.w), '-y', pt(m.y, s.h), '--tap-style', 'physical', '--udid', udid]);
      });

    case 'swipe': {
      if (![m.x1, m.y1, m.x2, m.y2].every(norm)) return;
      const duration = Math.min(Math.max(+m.duration || 0.25, 0.05), 5);
      if (INPUT === 'duo') {
        return enqueue(() => duoCmd(panel,
          `swipe ${m.x1.toFixed(4)} ${m.y1.toFixed(4)} ${m.x2.toFixed(4)} ${m.y2.toFixed(4)} ${Math.round(duration * 1000)}`));
      }
      return enqueue(async () => {
        const s = await ensurePoints();
        await runInput(['swipe',
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
      return enqueue(() => runInput(['key', String(code), '--udid', udid]));
    }

    case 'button':
      if (!BUTTONS.has(m.name)) return;
      return enqueue(() => runInput(['button', m.name, '--udid', udid]));

    case 'rotate':
      if (m.dir !== 'left' && m.dir !== 'right') return;
      return enqueue(() => rotateDevice(panel, m.dir));

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

// ---------------------------------------------------------------- http

// One page per panel, each told which panel it is and what it can switch to.
const template = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const menu = panels.map((p) => ({ name: p.name, label: p.label }));
for (const p of panels) {
  p.html = template.replace('__PANEL__', JSON.stringify({
    name: p.name, label: p.label, instance: LABEL,
    canRotate: p.canRotate === true, panels: menu,
  }));
}

// Hand the browser a cookie so the token can leave the URL, where it would
// otherwise sit in history, referrers and tunnel logs.
function setCookie(req, res) {
  res.setHeader('set-cookie', [
    `sim_token=${encodeURIComponent(TOKEN)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=86400',
    isHttps(req) ? 'Secure' : null,
  ].filter(Boolean).join('; '));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://local');
  if (!validToken(url.searchParams.get('t')) && !validToken(cookieToken(req))) return res.writeHead(404).end();

  // `/` is the old single-panel URL. Keep it working by sending it to the first
  // panel; the cookie goes out with the redirect, so the token need not follow.
  if (url.pathname === '/') {
    setCookie(req, res);
    res.writeHead(302, { location: `/${panels[0].name}`, 'cache-control': 'no-store' });
    return res.end();
  }

  const panel = byName.get(url.pathname.slice(1));
  if (!panel) return res.writeHead(404).end();

  setCookie(req, res);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(panel.html);
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://local');
  const panel = url.pathname.startsWith('/ws/') ? byName.get(url.pathname.slice(4)) : null;
  if (!panel || !sameOrigin(req) || !validToken(cookieToken(req))) return socket.destroy();
  // The cap is per panel, so one busy screen cannot lock viewers out of the other.
  if (panel.clients.size >= MAX_CLIENTS) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, panel));
});

wss.on('connection', (ws, panel) => {
  ws.visible = true;
  panel.clients.add(ws);
  // A client joining a panel that is already dark gets no transition, so say so now.
  if (panel.dark) ws.send(JSON.stringify({ type: 'panel', dark: true }));
  ws.send(activityMessage());
  startStream(panel);
  // The viewer count changed, so everyone's badge is now stale.
  sendActivity();

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

    handleInput(panel, m, ws);
  });

  ws.on('error', () => ws.close());
  ws.on('close', () => {
    panel.clients.delete(ws);
    // No tabs left on this panel: capture stops outright rather than backing off,
    // and the next connection starts it again.
    if (!panel.clients.size) stopStream(panel);
    sendActivity();
  });
});

// Tunnels drop idle websockets; a static screen may produce no frames.
setInterval(() => { for (const p of panels) for (const ws of p.clients) ws.ping(); }, 25_000).unref();

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
      for (const p of panels) log(`Public: ${m[0]}/${p.name}?t=${TOKEN}`);
    }
  });
  tunnel.on('error', (e) => logErr('cloudflared failed to start:', e.message, '(brew install cloudflared)'));
  tunnel.on('exit', (code) => { if (code) logErr(`cloudflared exited (${code})`); });
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') fail(`Port ${PORT} is already in use. Set PORT to something else.`);
  fail(`Server error: ${e.message}`);
});

if (perDisplayCapture) {
  resize = +SCALE < 1 || +QUALITY < 100;
  if (resize) {
    try {
      await run('ffmpeg', ['-version']);
    } catch {
      resize = false;
      warn('ffmpeg not found - sending full-resolution frames. SCALE and QUALITY are ignored.\n' +
                   'Install it for much smaller frames:  brew install ffmpeg');
    }
  }
  // Frames only go through ffmpeg when SCALE/QUALITY apply; without it they stay
  // full resolution and compress differently, so the dark test moves with them.
  if (!process.env.DARK_BYTES_PER_PX && !resize) darkPerPx = DARK_FULL;
  log(`Capturing per display via simctl (${SHOT_WORKERS} workers each${resize ? `, scale ${SCALE}` : ''}), dark below ${darkPerPx} B/px`);
} else {
  log('Capturing via axe stream-video (single panel; CAPTURE=simctl to pick a display)');
}

await readOrientation();
setInterval(pollOrientation, 3000).unref();

if (INPUT === 'duo') {
  try {
    await startDuo();
  } catch (e) {
    fail(`Could not start panel input:\n${(e.message || '').trim()}\n` +
         'Build it by hand to see why:  cd tools && clang -fobjc-arc -framework Foundation -o duoinput duoinput.m');
  }
} else if (panels.length > 1) {
  warn('INPUT=axe drives the outer panel only - taps on /inner will land on /outer. Use INPUT=duo.');
}

server.listen(PORT, HOST, () => {
  for (const p of panels) log(`Local:  http://localhost:${PORT}/${p.name}?t=${TOKEN}`);
  if (TUNNEL) startTunnel();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const p of panels) stopStream(p);
    duo?.proc.kill();
    tunnel?.kill();
    process.exit(0);
  });
}
