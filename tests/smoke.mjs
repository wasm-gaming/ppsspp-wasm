/**
 * Boot the real Emscripten build in a real browser, and say what happened.
 *
 * Everything else in `tests/` runs against `fake-module.mjs` and proves the *contract*.
 * This proves the *port*, and it exists because the port's open question cannot be seen
 * from a compile log: PPSSPP links, starts, initialises SDL3 — and then the browser tab
 * stops. A build round that ends at "it linked" buys nothing about that.
 *
 * The signal that matters is the **heartbeat**. A `setInterval` is started before
 * `callMain()`, and the runner asks the page for its count afterwards through CDP. If
 * `main()` blocks the browser's main thread — which is what PPSSPP's GL path does, by
 * design, on every other platform — then the interval cannot fire, the evaluation
 * cannot be answered, and the runner says so in one line instead of hanging. A blocked
 * main thread is not an absence of evidence here; it is the measurement.
 *
 * No Playwright, no test framework: Node 22 has a `WebSocket` client and Chromium
 * speaks CDP, so the whole thing is the standard library plus a browser that is already
 * installed. `make smoke` runs it; CI runs the same command against the artifacts it
 * just built.
 *
 * Usage: node tests/smoke.mjs [--artifacts=src/native] [--timeout=90] [--chromium=PATH]
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, extname, resolve } from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v = 'true'] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);

const ARTIFACTS = resolve(args.artifacts ?? 'src/native');
const TIMEOUT_MS = Number(args.timeout ?? 90) * 1000;
const POOL = Number(args.pool ?? 8);
const CHROMIUM =
  args.chromium ??
  process.env.CHROMIUM_PATH ??
  ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']
    .find((p) => existsSync(p));

// ---------------------------------------------------------------------------
// The page under test.
//
// It is written here rather than in a file because it is part of the instrument: the
// order of these statements is the experiment. The heartbeat and the frame counter are
// installed *before* callMain, because after it there may be no main thread left to
// install them on.
// ---------------------------------------------------------------------------
const HARNESS = `<!doctype html>
<meta charset="utf-8">
<title>ppsspp smoke</title>
<style>html,body{margin:0;background:#111}canvas{display:block;width:480px;height:272px}</style>
<!--
  id="canvas" because SDL3's Emscripten video driver resolves a CSS selector from
  SDL_HINT_EMSCRIPTEN_CANVAS_SELECTOR, defaulting to "#canvas", and fails window
  creation outright when nothing matches. The SDK cannot use that id — it builds a new
  canvas per restart — but that is a separate open question, and this harness tests one
  thing at a time.
-->
<canvas id="canvas" width="480" height="272"></canvas>
<script type="module">
  const state = {
    stage: 'loading',
    heartbeat: 0,
    loopTurns: 0,
    stdout: [],
    stderr: [],
    events: [],
    error: null,
  };
  window.__smoke = state;
  const say = (m) => { try { __smokeReport(JSON.stringify(m)); } catch {} };

  // Both counters run on the browser's main thread. They are the whole point: if
  // main() blocks it, these stop, and stopping is the result.
  setInterval(() => { state.heartbeat++; }, 100);
  // Not "frames PPSSPP drew" — this counter cannot know that. It counts times the
  // browser handed the main thread back to the page, which is the property the port is
  // missing and the only one observable from out here.
  const tick = () => { state.loopTurns++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);

  const keep = (bucket, text) => {
    state[bucket].push(text);
    if (state[bucket].length > 400) state[bucket].shift();
    say({ kind: bucket, text });
  };

  try {
    state.stage = 'importing';
    say({ kind: 'stage', text: 'importing' });
    const { default: createPpsspp } = await import('/native/ppsspp.js');

    state.stage = 'instantiating';
    say({ kind: 'stage', text: 'instantiating' });
    const mod = await createPpsspp({
      canvas: document.getElementById('canvas'),
      pthreadPoolSize: ${POOL},
      print: (t) => keep('stdout', t),
      printErr: (t) => keep('stderr', t),
      onAbort: (what) => { state.error = 'abort: ' + what; say({ kind: 'abort', text: String(what) }); },
      ppssppEvent: (e) => { state.events.push(e); say({ kind: 'event', text: JSON.stringify(e) }); },
    });

    state.stage = 'instantiated';
    say({ kind: 'stage', text: 'instantiated' });

    // Yield first, so the report above is delivered even if the call below never
    // returns. Without this the runner cannot tell "never instantiated" from
    // "instantiated and then froze", and those have different causes.
    await new Promise((r) => setTimeout(r, 50));
    const before = state.heartbeat;

    state.stage = 'callMain';
    say({ kind: 'stage', text: 'callMain' });
    mod.callMain([]);

    state.stage = 'returned';
    say({ kind: 'stage', text: 'callMain returned', heartbeatDuringCall: state.heartbeat - before });
  } catch (e) {
    state.stage = 'threw';
    state.error = String(e && e.stack || e);
    say({ kind: 'threw', text: state.error });
  }
</script>`;

// ---------------------------------------------------------------------------
// A server that is cross-origin isolated.
//
// COOP/COEP are what make SharedArrayBuffer exist, and without SharedArrayBuffer a
// pthreads build does not start at all. The demo gets these from a service worker
// because GitHub Pages cannot set headers; here they are set directly, which is one
// fewer moving part between the runner and the emulator.
// ---------------------------------------------------------------------------
const TYPES = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.data': 'application/octet-stream',
  '.html': 'text/html',
};

function serve() {
  const server = createServer(async (req, res) => {
    const headers = {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cache-Control': 'no-store',
    };
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/') {
      res.writeHead(200, { ...headers, 'Content-Type': 'text/html' });
      res.end(HARNESS);
      return;
    }
    if (url.pathname.startsWith('/native/')) {
      const file = join(ARTIFACTS, url.pathname.slice('/native/'.length));
      try {
        const body = await readFile(file);
        res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404, headers);
        res.end('no ' + file);
      }
      return;
    }
    res.writeHead(404, headers);
    res.end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

// ---------------------------------------------------------------------------
// Chromium, over CDP.
// ---------------------------------------------------------------------------
function launch() {
  const profile = mkdtempSync(join(tmpdir(), 'ppsspp-smoke-'));
  const child = spawn(CHROMIUM, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // Headless has no GPU, and PPSSPP needs a real WebGL2 context to get past window
    // creation. SwiftShader is a software rasteriser: slow, and enough to prove the
    // context was made and the frames are moving.
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--enable-features=SharedArrayBuffer',
    '--js-flags=--experimental-wasm-threads',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  return new Promise((resolveWs, rejectWs) => {
    const timer = setTimeout(() => rejectWs(new Error('Chromium never printed a DevTools endpoint')), 30000);
    let buf = '';
    child.stderr.on('data', (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolveWs({ child, wsUrl: m[1] });
      }
    });
    child.on('exit', (code) => { clearTimeout(timer); rejectWs(new Error(`Chromium exited (${code})\n${buf}`)); });
  });
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const listeners = [];

  const ready = new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', () => j(new Error('CDP socket failed')), { once: true });
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: ok, reject: no } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? no(new Error(msg.error.message)) : ok(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  });

  /**
   * `timeout` is not a convenience. An evaluation the page never answers is the
   * measurement this whole file exists to take, so it has to come back as a value
   * rather than hang the runner.
   */
  const send = (method, params = {}, sessionId, timeout = 0) =>
    new Promise((ok, no) => {
      const id = nextId++;
      pending.set(id, { resolve: ok, reject: no });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      if (timeout) {
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            no(new Error('TIMEOUT'));
          }
        }, timeout);
      }
    });

  return { ready, send, on: (fn) => listeners.push(fn), close: () => ws.close() };
}

// ---------------------------------------------------------------------------
const log = [];
const record = (kind, text) => {
  const line = `[${kind}] ${text}`;
  log.push(line);
  console.log(line);
};

async function main() {
  if (!CHROMIUM) {
    console.error('No Chromium found. Pass --chromium=PATH or set CHROMIUM_PATH.');
    process.exit(2);
  }
  if (!existsSync(join(ARTIFACTS, 'ppsspp.js'))) {
    console.error(`No ppsspp.js in ${ARTIFACTS} — build it first (make wasm), or pass --artifacts=DIR.`);
    process.exit(2);
  }

  const server = await serve();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { child, wsUrl } = await launch();
  const browser = connect(wsUrl);
  await browser.ready;

  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });

  let crashed = false;
  const stages = [];
  browser.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    const p = msg.params ?? {};
    switch (msg.method) {
      case 'Runtime.bindingCalled': {
        if (p.name !== '__smokeReport') break;
        const m = JSON.parse(p.payload);
        if (m.kind === 'stage') stages.push(m.text);
        record(m.kind, m.text + (m.heartbeatDuringCall !== undefined ? ` (heartbeats during the call: ${m.heartbeatDuringCall})` : ''));
        break;
      }
      case 'Runtime.consoleAPICalled':
        record('console', (p.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' '));
        break;
      case 'Runtime.exceptionThrown':
        record('exception', p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text ?? '?');
        break;
      case 'Log.entryAdded':
        record('log:' + p.entry.level, p.entry.text);
        break;
      case 'Inspector.targetCrashed':
        crashed = true;
        record('CRASH', 'the renderer process died');
        break;
    }
  });

  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('Log.enable', {}, sessionId);
  await browser.send('Page.enable', {}, sessionId);
  await browser.send('Inspector.enable', {}, sessionId);
  await browser.send('Runtime.addBinding', { name: '__smokeReport' }, sessionId);

  record('runner', `serving ${ARTIFACTS} at ${origin}, pool ${POOL}, timeout ${TIMEOUT_MS / 1000}s`);
  await browser.send('Page.navigate', { url: origin + '/' }, sessionId);

  // Poll the page rather than waiting on it. Each probe is an independent question —
  // "is the main thread answering?" — and the answer "no" is what a frozen tab looks
  // like from outside.
  const started = Date.now();
  let probe = null;
  let blockedSince = null;
  while (Date.now() - started < TIMEOUT_MS && !crashed) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const { result } = await browser.send(
        'Runtime.evaluate',
        { expression: 'JSON.stringify({stage:__smoke.stage,heartbeat:__smoke.heartbeat,loopTurns:__smoke.loopTurns,error:__smoke.error})', returnByValue: true },
        sessionId,
        2000,
      );
      probe = JSON.parse(result.value);
      blockedSince = null;
      if (probe.stage === 'returned' && probe.loopTurns > 0) {
        // Let it run a little past the finish line: a main loop that registers and
        // then dies on its first frame is not a working main loop.
        if (Date.now() - started > 8000) break;
      }
      if (probe.stage === 'threw') break;
    } catch {
      if (blockedSince === null) {
        blockedSince = Date.now();
        record('runner', 'the page stopped answering — main thread busy or blocked');
      } else if (Date.now() - blockedSince > 10000) {
        record('runner', 'still not answering after 10s: treating the main thread as blocked');
        break;
      }
    }
  }

  // ---- the verdict ----
  let verdict, code;
  if (crashed) {
    verdict = 'CRASHED — the renderer process died.';
    code = 1;
  } else if (blockedSince !== null) {
    verdict = `BLOCKED — the main thread stopped answering at stage "${stages.at(-1) ?? '?'}". This is the failure the port is chasing: whatever runs at that stage does not return to the browser's event loop.`;
    code = 1;
  } else if (!probe) {
    verdict = 'NO ANSWER — the page never reported anything at all.';
    code = 1;
  } else if (probe.error) {
    verdict = `FAILED — ${probe.error}`;
    code = 1;
  } else if (probe.stage !== 'returned') {
    verdict = `STOPPED at "${probe.stage}" — see the transcript above.`;
    code = 1;
  } else if (probe.loopTurns === 0) {
    verdict = 'ALIVE BUT STALLED — callMain returned and the main thread answers, but the browser never handed it back to the page.';
    code = 1;
  } else {
    verdict = `RUNNING — callMain returned and the main thread kept turning: ${probe.loopTurns} event-loop turns, ${probe.heartbeat} heartbeats. This says the tab survives, not that PPSSPP drew anything.`;
    code = 0;
  }

  console.log('\n' + '='.repeat(72));
  if (probe) console.log(`stage=${probe.stage} heartbeat=${probe.heartbeat} loopTurns=${probe.loopTurns}`);
  console.log(verdict);
  console.log('='.repeat(72));

  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## Browser smoke\n\n**${verdict}**\n\n` +
        (probe ? `\`stage=${probe.stage} heartbeat=${probe.heartbeat} loopTurns=${probe.loopTurns}\`\n\n` : '') +
        '```\n' + log.slice(-120).join('\n') + '\n```\n',
    );
  }

  browser.close();
  child.kill('SIGKILL');
  server.close();
  process.exit(code);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
