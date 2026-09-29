#!/usr/bin/env node
// Start one server per simulator from a JSON file, so a multi-device setup is
// one command instead of one terminal tab each.
//
//   node tools/run-sims.mjs [config]        (default: sims.json)
//
// Every child inherits this process's stdio, and the server tags each of its
// own lines with the instance label, so the interleaved output stays readable.
// Ctrl-C stops all of them; if any child exits, the rest are stopped too,
// because a half-running set is worse than none - you would not notice.

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const configPath = process.argv[2] || 'sims.json';
const serverPath = fileURLToPath(new URL('../server.js', import.meta.url));

let config;
try {
  config = JSON.parse(await readFile(configPath, 'utf8'));
} catch (e) {
  console.error(`Could not read ${configPath}: ${e.message}`);
  console.error('Copy sims.example.json to sims.json and fill in your UDIDs.');
  process.exit(1);
}

const sims = Array.isArray(config) ? config : config.sims;
if (!Array.isArray(sims) || !sims.length) {
  console.error(`${configPath} must hold a "sims" array with at least one entry.`);
  process.exit(1);
}

// Two instances sharing a port silently lose one to EADDRINUSE, and two sharing
// a UDID drive the same device from two pages. Both are quiet failures worth
// refusing up front.
function checkUnique(field, pretty) {
  const seen = new Map();
  for (const sim of sims) {
    const value = sim[field];
    if (value === undefined) continue;
    const first = seen.get(value);
    if (first !== undefined) {
      console.error(`${pretty} ${value} is used by both "${first}" and "${sim.label}".`);
      process.exit(1);
    }
    seen.set(value, sim.label ?? `entry ${sims.indexOf(sim) + 1}`);
  }
}
checkUnique('port', 'Port');
checkUnique('udid', 'UDID');

// A shared token would let a viewer of one simulator drive another, so each
// instance gets its own. Left unset, the server generates one and prints it.
const children = sims.map((sim) => {
  const { label, udid, port, tunnel, env = {} } = sim;
  const args = tunnel ? ['--tunnel'] : [];
  const child = spawn(process.execPath, [serverPath, ...args], {
    stdio: 'inherit',
    env: {
      ...process.env,
      ...env,
      ...(label ? { LABEL: label } : {}),
      ...(udid ? { UDID: udid } : {}),
      ...(port ? { PORT: String(port) } : {}),
    },
  });
  child.on('error', (e) => {
    console.error(`[${label ?? port}] failed to start: ${e.message}`);
    stopAll(1);
  });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`[${label ?? port}] exited (${code ?? signal}); stopping the rest.`);
    stopAll(code || 1);
  });
  return child;
});

let stopping = false;
function stopAll(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  // Give each server its own shutdown path (it stops capture and kills the
  // duoinput helper) before the launcher goes away.
  setTimeout(() => process.exit(code), 1500).unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => stopAll(0));

console.log(`Starting ${sims.length} simulator server${sims.length === 1 ? '' : 's'} from ${configPath}.`);
