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
 * The heartbeat is not the whole verdict any more. It says the tab survived; it cannot
 * say a picture was drawn, and a build that comes up, registers a loop and paints
 * nothing produces the identical number. So the run also reads the canvas back and
 * grades what it finds — see "reading the picture back" in the harness below.
 *
 * No Playwright, no test framework: Node 22 has a `WebSocket` client and Chromium
 * speaks CDP, so the whole thing is the standard library plus a browser that is already
 * installed. `make smoke` runs it; CI runs the same command against the artifacts it
 * just built. `make smoke-selftest` points it at fakes that fail on purpose, because an
 * instrument that cannot fail is not an instrument.
 *
 * Usage: node tests/smoke.mjs [--artifacts=src/native] [--timeout=90] [--settle=8]
 *                             [--pool=16] [--loglevel=4] [--chromium=PATH]
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
// How long a run keeps going after it has everything it needs. A main loop that
// registers and then dies on its first frame is not a working main loop, and under
// SwiftShader the first frame with anything on it takes a while to arrive.
const SETTLE_MS = Number(args.settle ?? 8) * 1000;
// PPSSPP's own log level, passed to callMain as --loglevel=N.
//
// Not a nicety. Config::Load() calls LogManager::LoadConfig(), which sets *every*
// channel to LERROR when the ini has no [Log] section — and a smoke run always boots on
// a fresh memory stick, so it never does. LINFO is 4 and LERROR is 2, and LogLine drops
// anything numerically above the channel's level, so from that moment on the entire boot
// is invisible: no "Entering separate emu thread", no GL version string, nothing. Round
// 18 read that silence as a stalled emu thread, and the silence does not support it.
//
// NativeInit applies the command line *after* the config, so this wins. 0 passes no flag
// at all and restores the old, mute behaviour.
const LOG_LEVEL = Number(args.loglevel ?? 4);
// Sized for a deadlock, not for speed. Emscripten grows its worker pool by returning
// to the event loop; PPSSPP's render thread does not return to the event loop while it
// waits for a frame. So a pool that runs out mid-boot does not slow down — it stops:
// "Tried to spawn a new thread, but the thread pool is exhausted." 8 was not enough.
const POOL = Number(args.pool ?? 16);
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
  Deliberately *not* id="canvas", which is what SDL3's Emscripten video driver falls
  back to when SDL_HINT_EMSCRIPTEN_CANVAS_SELECTOR is unset. The SDK cannot use that id
  — it builds a new canvas per session, and they cannot all be called the same thing —
  so it writes the selector into Module.ENV before callMain, and this page does the
  same. Naming the element anything else is what makes that a real test: if the hint
  never reaches SDL, window creation fails outright rather than quietly finding a
  canvas the SDK would never have.
-->
<canvas id="ppsspp-smoke" width="480" height="272"></canvas>
<script type="module">
  const state = {
    stage: 'loading',
    heartbeat: 0,
    loopTurns: 0,
    contexts: 0,
    contextAttrs: null,
    foreignFrames: 0,
    gl: {
      draws: 0, drawsToCanvas: 0, clears: 0, clearsToCanvas: 0,
      binds: 0, bindsDefault: 0, bindTargets: {}, firstBinds: [], bindKinds: {},
      onCanvas: true,
    },
    pixels: { samples: 0, opaque: 0, distinct: 0, best: 0, changed: 0, backdrop: 0, hash: null, error: null },
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

  // Who *else* is asking for animation frames. Emscripten drives
  // emscripten_set_main_loop(fn, 0) — which is what patch 0008 registers — from
  // requestAnimationFrame, so a main loop that is really running shows up here as
  // somebody other than this harness scheduling frames.
  //
  // The asymmetry is the point and is worth stating: a number that grows does not prove
  // oneIteration() is what is growing it, since anything on the page may schedule a
  // frame. A number that stays at zero is strong evidence that nothing registered a
  // main loop, or that it stopped being called. Round 17 could distinguish neither.
  const realRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => {
    if (cb !== tick) state.foreignFrames++;
    return realRaf(cb);
  };

  const CANVAS_SELECTOR = '#ppsspp-smoke';
  const canvas = document.querySelector(CANVAS_SELECTOR);

  // -- reading the picture back ---------------------------------------------
  //
  // loopTurns proves the tab lives. It cannot prove anything was drawn, and a build
  // that comes up, registers a loop and paints nothing at all produces the identical
  // number. This is the part that can tell those apart.
  //
  // A WebGL drawing buffer is cleared the instant it is composited, so by the time
  // anything out here looks at it there is nothing left to see. preserveDrawingBuffer
  // is the documented way to keep it, and it has to be forced *before* the module makes
  // its context: Emscripten passes its own attributes and never asks for this.
  //
  // Said out loud as an observer effect, because it is one — the same family as the
  // -sASSERTIONS tripwire that killed SDL_CreateWindow. It costs a buffer copy per
  // frame and removes the implicit clear between frames. PPSSPP clears its own target
  // every frame, so it should not change what is drawn; "should" is the honest strength
  // of that claim, and a DRAWING verdict that only appears with this flag on would be
  // the thing to distrust.
  //
  // The same wrapper counts what the emulator asks GL to do, because "nothing was
  // drawn" has two very different causes and the canvas alone cannot separate them. A
  // port issuing no draw calls at all is not rendering; one issuing thousands while
  // never binding the default framebuffer is rendering somewhere else and never
  // blitting. Round 17 reported BLANK and could not say which.
  const watch = (ctx) => {
    const g = state.gl;
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const real = ctx[name];
      if (typeof real !== 'function') continue;
      ctx[name] = function (...a) {
        g.draws++;
        if (g.onCanvas) g.drawsToCanvas++;
        return real.apply(this, a);
      };
    }
    const realClear = ctx.clear;
    ctx.clear = function (...a) {
      g.clears++;
      if (g.onCanvas) g.clearsToCanvas++;
      return realClear.apply(this, a);
    };
    const realBind = ctx.bindFramebuffer;
    ctx.bindFramebuffer = function (target, fb) {
      g.binds++;
      // Named rather than merely counted. "No draw reached the canvas" is a claim about
      // a bind that never happened, and a claim about a call nobody saw is worth less
      // than the call itself. PPSSPP's fbo_unbind() binds GL_FRAMEBUFFER with a zero
      // name, which Emscripten forwards as null — so if the backbuffer is ever made the
      // render target, it appears here as FRAMEBUFFER:null and nowhere else.
      const name = target === this.FRAMEBUFFER ? 'FRAMEBUFFER'
        : target === this.DRAW_FRAMEBUFFER ? 'DRAW_FRAMEBUFFER'
        : target === this.READ_FRAMEBUFFER ? 'READ_FRAMEBUFFER'
        : String(target);
      // Falsy, not strictly null. Round 23 counted 7098 binds and not one null, which
      // read as "PPSSPP never targets the backbuffer" — and the emulator's own code says
      // that cannot be. The gap is here: Emscripten's glBindFramebuffer forwards
      // GL.framebuffers[name], and index 0 is a hole in that array, so a zero name
      // arrives as undefined. WebGL accepts undefined as null and renders fine; a
      // strict === null test does not see it at all.
      const isDefault = !fb;
      const key = name + (isDefault ? ':default' : ':fbo');
      g.bindTargets[key] = (g.bindTargets[key] || 0) + 1;
      // Kept so the next round proves this rather than re-deriving it: what a default
      // bind actually arrives as.
      const kind = fb === null ? 'null' : fb === undefined ? 'undefined' : typeof fb;
      g.bindKinds[kind] = (g.bindKinds[kind] || 0) + 1;
      if (isDefault) g.bindsDefault++;
      if (g.firstBinds.length < 24) g.firstBinds.push(key);
      // FRAMEBUFFER and DRAW_FRAMEBUFFER decide where a draw lands. READ_FRAMEBUFFER
      // does not, so it must not move this flag.
      if (target === this.FRAMEBUFFER || target === this.DRAW_FRAMEBUFFER) g.onCanvas = isDefault;
      return realBind.call(this, target, fb);
    };
    return ctx;
  };

  const realGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type !== 'webgl2' && type !== 'webgl' && type !== 'experimental-webgl') {
      return realGetContext.call(this, type, attrs);
    }
    state.contexts++;
    const ctx = realGetContext.call(this, type, Object.assign({}, attrs || {}, { preserveDrawingBuffer: true }));
    // Reported, not overridden. A drawing buffer with an alpha channel that the
    // emulator leaves at zero is transparent, and drawImage composites a zero-alpha
    // pixel to nothing — which reads back as both "no opaque pixel" and "one colour",
    // the exact pair of numbers this run keeps producing. If that is what is happening,
    // the fix belongs in the port, not in here: a harness that quietly forces alpha off
    // would go green while everything it ships stayed broken.
    try {
      if (ctx && ctx.getContextAttributes) state.contextAttrs = ctx.getContextAttributes();
    } catch (e) {
      state.contextAttrs = { error: String(e) };
    }
    return ctx ? watch(ctx) : ctx;
  };

  // Sampled through drawImage rather than gl.readPixels on purpose. readPixels reads
  // whichever framebuffer is bound, so it would have to bind, read and rebind — and
  // patch 0009 means a frame can be sitting half-finished between animation frames,
  // with GL state the instrument has no business touching. drawImage asks the browser
  // for the canvas's own contents and leaves those bindings alone.
  //
  // 120x68 is a quarter of the canvas: small enough to summarise four times a second,
  // large enough that a menu does not average down to one colour.
  const SHOT_W = 120, SHOT_H = 68;
  const shot = document.createElement('canvas');
  shot.width = SHOT_W;
  shot.height = SHOT_H;
  const shotCtx = shot.getContext('2d', { willReadFrequently: true });

  // The same read a second time, onto an opaque backdrop, and it is the whole of the
  // experiment that tells the two candidate explanations apart. A drawing buffer whose
  // alpha the emulator never wrote composites to nothing above and to its own colour
  // here, because the backdrop supplies the alpha it is missing; a canvas this sampler
  // simply cannot read comes back flat both times. One is a finding about the port, the
  // other about the instrument, and they are one drawImage apart.
  const over = document.createElement('canvas');
  over.width = SHOT_W;
  over.height = SHOT_H;
  const overCtx = over.getContext('2d', { willReadFrequently: true });

  const sample = () => {
    let data;
    try {
      shotCtx.clearRect(0, 0, SHOT_W, SHOT_H);
      shotCtx.drawImage(canvas, 0, 0, SHOT_W, SHOT_H);
      data = shotCtx.getImageData(0, 0, SHOT_W, SHOT_H).data;
    } catch (e) {
      state.pixels.error = String(e);
      return;
    }
    const colours = new Set();
    let opaque = 0;
    let hash = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] !== 0) opaque++;
      colours.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      hash = (Math.imul(hash, 31) + data[i] + data[i + 1] * 3 + data[i + 2] * 7 + data[i + 3] * 11) >>> 0;
    }
    const p = state.pixels;
    p.samples++;
    p.opaque = opaque;
    p.distinct = colours.size;
    // The best sample, not the last. A UI that draws and then blanks still drew, and
    // the run should say so rather than depend on when the last probe landed.
    if (colours.size > p.best) p.best = colours.size;
    if (p.hash === null) p.hash = hash;
    else if (p.hash !== hash) { p.changed++; p.hash = hash; }

    try {
      overCtx.fillStyle = '#000';
      overCtx.fillRect(0, 0, SHOT_W, SHOT_H);
      overCtx.drawImage(canvas, 0, 0, SHOT_W, SHOT_H);
      const lit = overCtx.getImageData(0, 0, SHOT_W, SHOT_H).data;
      const seen = new Set();
      for (let i = 0; i < lit.length; i += 4) seen.add((lit[i] << 16) | (lit[i + 1] << 8) | lit[i + 2]);
      if (seen.size > p.backdrop) p.backdrop = seen.size;
    } catch { /* the plain read above already carries the error */ }
  };
  setInterval(sample, 250);

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
      canvas,
      pthreadPoolSize: ${POOL},
      // The glue is served under /native/ and the page is at /, which is the shape of
      // a real host — the emulator inside node_modules, the page anywhere. Without
      // this, Emscripten asks the *document* for ppsspp.data, gets a 404 and waits for
      // it forever. src/loader.ts defaults to exactly this; the harness says it out
      // loud because here there is no loader in the way.
      locateFile: (path) => '/native/' + path,
      // See src/loader.ts: SDL3 assigns Module['requestFullscreen'], and -sASSERTIONS
      // turns every unexported runtime symbol into a getter-only tripwire. The harness
      // bypasses the loader, so it seeds the same property itself.
      requestFullscreen: undefined,
      print: (t) => keep('stdout', t),
      printErr: (t) => keep('stderr', t),
      onAbort: (what) => { state.error = 'abort: ' + what; say({ kind: 'abort', text: String(what) }); },
      ppssppEvent: (e) => { state.events.push(e); say({ kind: 'event', text: JSON.stringify(e) }); },
    });

    state.stage = 'instantiated';
    say({ kind: 'stage', text: 'instantiated' });

    // How SDL3 is told where to render, and the same line src/loader.ts runs. SDL_GetHint
    // reads the environment before its own hint table, and the window is not created
    // until main() runs, so writing it here is in time. Reported rather than assumed:
    // a build whose ENV is not exported would throw here instead of failing later
    // inside SDL, where the message says nothing about a canvas.
    mod.ENV.SDL_EMSCRIPTEN_CANVAS_SELECTOR = CANVAS_SELECTOR;
    say({ kind: 'stage', text: 'canvas selector ' + CANVAS_SELECTOR });

    // Yield first, so the report above is delivered even if the call below never
    // returns. Without this the runner cannot tell "never instantiated" from
    // "instantiated and then froze", and those have different causes.
    await new Promise((r) => setTimeout(r, 50));
    const before = state.heartbeat;

    state.stage = 'callMain';
    say({ kind: 'stage', text: 'callMain' });
    mod.callMain(${JSON.stringify(LOG_LEVEL > 0 ? [`--loglevel=${LOG_LEVEL}`] : [])});

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
// Emscripten's "still waiting on run dependencies" diagnostic lists every preloaded
// file, and repeats every few seconds — around a thousand lines of it in a two-minute
// run, which buries the transcript that matters. The count is the information; the file
// names are not. Kept as one line per dump.
let depRun = 0;
const record = (kind, text) => {
  if (/^dependency: fp /.test(text)) { depRun++; return; }
  if (depRun && !/^dependency: /.test(text)) {
    const line = `[deps] ...and ${depRun} preloaded files still pending`;
    log.push(line);
    console.log(line);
    depRun = 0;
  }
  const line = `[${kind}] ${text}`;
  log.push(line);
  console.log(line);
};

/**
 * Did anything get drawn? One colour is a clear, not a picture — every renderer clears,
 * so a flat canvas is exactly what a build that comes up and paints nothing looks like.
 * Two samples, because one is not a trend and the first one can land before the first
 * frame does.
 */
const drew = (p) => (p.pixels?.best ?? 0) > 1 && (p.pixels?.samples ?? 0) >= 2;

/**
 * Is the picture there and invisible to anything that composites it?
 *
 * The canvas reads as empty when it is drawn into a transparent target and has colour
 * in it when it is drawn over an opaque one. Only one thing does that: a drawing buffer
 * carrying the picture with its alpha left at zero. The browser treats such a buffer as
 * premultiplied, so putting it on the page is `src.rgb + page.rgb`, which looks perfect;
 * every other consumer gets `src.rgb + 0` at alpha 0, which `getImageData` un-premultiplies
 * back to nothing.
 *
 * It is a defect in the port and not in the sampler, and the fix belongs in the port: ask
 * Emscripten for a context with no alpha channel. Forcing it here would turn this run
 * green while every host embedding this canvas still saw nothing.
 */
const transparent = (p) => (p.pixels?.best ?? 0) <= 1 && (p.pixels?.backdrop ?? 0) > 1;

/** What the two readings of the canvas were, once they disagree. */
const alphaNote = (p) =>
  transparent(p)
    ? ` The in-page sampler reads that same canvas as empty — ${p.pixels.opaque} opaque pixels in ${p.pixels.samples} samples — and reads ${p.pixels.backdrop} colours from it over an opaque backdrop. ` +
      'The picture is in the drawing buffer with its alpha at zero, so the browser adds it to the page and everything else gets nothing. ' +
      'A host that composites this canvas sees what the sampler sees. Context attributes below say whether it was asked for with an alpha channel.'
    : (p.pixels?.best ?? 0) <= 1
      ? ' The in-page sampler reads the canvas as empty over an opaque backdrop too, so this is not the alpha channel: the sampler is not reading this canvas at all, which is a finding about the instrument rather than about the port.'
      : '';

let shotNote = '';
const vitals = (p) =>
  `stage=${p.stage} heartbeat=${p.heartbeat} loopTurns=${p.loopTurns} foreignFrames=${p.foreignFrames ?? 0} contexts=${p.contexts ?? 0}${shotNote} ` +
  (p.pixels
    ? `pixels=${p.pixels.samples} samples, best ${p.pixels.best} colours, ${p.pixels.changed} changed, ${p.pixels.opaque} opaque, ${p.pixels.backdrop} over black`
    : 'pixels=none');

/**
 * What the emulator asked GL to do, for the verdicts where it drew nothing. This is the
 * half that says *which* kind of nothing: no draw calls at all is a loop that is not
 * running; draw calls that never land on the default framebuffer is a renderer that
 * never blits.
 */
const glNote = (p) =>
  p.gl
    ? ` GL: ${p.gl.draws} draw calls (${p.gl.drawsToCanvas} with the default framebuffer bound), ${p.gl.clears} clears (${p.gl.clearsToCanvas} to it), ${p.gl.binds} framebuffer binds ` +
      `— ${JSON.stringify(p.gl.bindTargets ?? {})}, arriving as ${JSON.stringify(p.gl.bindKinds ?? {})}. ` +
      `Context attributes: ${JSON.stringify(p.contextAttrs ?? null)}. ` +
      `Something other than the harness asked for ${p.foreignFrames ?? 0} animation frames.`
    : '';

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
  const inflight = new Map();
  const served = new Map();
  const broken = [];
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
      case 'Network.requestWillBeSent':
        inflight.set(p.requestId, p.request.url);
        break;
      case 'Network.responseReceived':
        if (p.response.status >= 400) {
          // A 4xx whose body nobody reads never reports loadingFinished, so it has to
          // be moved out of "in flight" here or it gets reported as a slow fetch.
          inflight.delete(p.requestId);
          if (!/\/favicon\.ico$/.test(p.response.url)) {
            broken.push(`${p.response.status} ${p.response.url}`);
            record('http', `${p.response.status} ${p.response.url}`);
          }
        } else {
          served.set(p.response.url, p.response.status);
        }
        break;
      case 'Network.loadingFinished':
        inflight.delete(p.requestId);
        break;
      case 'Network.loadingFailed': {
        const what = `${inflight.get(p.requestId) ?? p.requestId}: ${p.errorText}${p.blockedReason ? ' (' + p.blockedReason + ')' : ''}`;
        broken.push(what);
        record('http', 'FAILED ' + what);
        inflight.delete(p.requestId);
        break;
      }
      case 'Inspector.targetCrashed':
        crashed = true;
        record('CRASH', 'the renderer process died');
        break;
    }
  });

  // The Network domain earns its place: the first real run of this instrument stopped
  // at "instantiating" and the transcript could not say whether a fetch had 404'd or
  // was simply still in flight. A module that never finishes coming up is nearly always
  // waiting on a file, so the file is what has to be reported.
  await browser.send('Network.enable', {}, sessionId);
  await browser.send('Runtime.enable', {}, sessionId);
  await browser.send('Log.enable', {}, sessionId);
  await browser.send('Page.enable', {}, sessionId);
  await browser.send('Inspector.enable', {}, sessionId);
  await browser.send('Runtime.addBinding', { name: '__smokeReport' }, sessionId);

  record(
    'runner',
    `serving ${ARTIFACTS} at ${origin}, pool ${POOL}, timeout ${TIMEOUT_MS / 1000}s, ` +
      (LOG_LEVEL > 0 ? `PPSSPP log level ${LOG_LEVEL}` : 'PPSSPP log level left at its default'),
  );
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
        { expression: 'JSON.stringify({stage:__smoke.stage,heartbeat:__smoke.heartbeat,loopTurns:__smoke.loopTurns,error:__smoke.error,contexts:__smoke.contexts,contextAttrs:__smoke.contextAttrs,foreignFrames:__smoke.foreignFrames,gl:__smoke.gl,pixels:__smoke.pixels})', returnByValue: true },
        sessionId,
        2000,
      );
      probe = JSON.parse(result.value);
      blockedSince = null;
      if (probe.stage === 'returned' && probe.loopTurns > 0 && drew(probe)) {
        // Only a run that has its answer stops early. A build that comes up and never
        // draws now costs the whole timeout, which is the right price: "nothing was
        // drawn" is the slowest thing here to be sure of, and calling it early is how
        // an instrument starts lying.
        if (Date.now() - started > SETTLE_MS) break;
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

  // What the browser actually shows, clipped to the canvas.
  //
  // This is the verdict's evidence now, and the drawImage sampling in the page has been
  // demoted to a second opinion. Round 25 is why: the compositor returned a 46 KB PNG of
  // a region the in-page sampler was reading as empty, and a 480x272 blank rectangle does
  // not compress to 46 KB. The context is created with alpha and premultipliedAlpha, so a
  // drawing buffer the emulator leaves at zero alpha composites to nothing when *we* draw
  // it into a scratch canvas — while the browser puts it on screen perfectly well. The
  // sampler was measuring its own compositing, not the port.
  //
  // A screenshot has no such problem: it is opaque pixels of what a person would see.
  // Clipped to the canvas so the page's own background cannot be mistaken for content.
  let shot = null;
  try {
    const { result: rectResult } = await browser.send(
      'Runtime.evaluate',
      { expression: 'JSON.stringify((({x,y,width,height}) => ({x,y,width,height}))(document.querySelector("#ppsspp-smoke").getBoundingClientRect()))', returnByValue: true },
      sessionId,
      5000,
    );
    const rect = JSON.parse(rectResult.value);
    const png = await browser.send(
      'Page.captureScreenshot',
      { format: 'png', clip: { ...rect, scale: 1 }, captureBeyondViewport: true },
      sessionId,
      15000,
    );
    // Graded in the page, because Node has no PNG decoder and the browser is right there.
    // A PNG is opaque, so this counts the colours a viewer would actually see.
    const grade = await browser.send(
      'Runtime.evaluate',
      {
        expression:
          '(async () => { const i = new Image(); i.src = "data:image/png;base64," + ' +
          JSON.stringify(png.data) +
          '; await i.decode(); const c = document.createElement("canvas"); c.width = 120; c.height = 68;' +
          ' const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(i, 0, 0, c.width, c.height);' +
          ' const d = x.getImageData(0, 0, c.width, c.height).data; const s = new Set();' +
          ' for (let n = 0; n < d.length; n += 4) s.add((d[n] << 16) | (d[n + 1] << 8) | d[n + 2]);' +
          ' return JSON.stringify({ colours: s.size }); })()',
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
      15000,
    );
    shot = { bytes: Math.round((png.data?.length ?? 0) * 3 / 4), ...JSON.parse(grade.result.value) };
    shotNote = ` screenshot=${shot.bytes}B/${shot.colours}col`;
  } catch (e) {
    // A page that cannot answer has already been reported as BLOCKED; nothing to add.
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
    // A module that never finishes coming up is nearly always waiting on a file, so a
    // request that failed outranks one that is merely slow.
    const pending = [...inflight.values()].filter((u) => !/\/favicon\.ico$/.test(u));
    verdict =
      `STOPPED at "${probe.stage}" — the main thread is alive (${probe.heartbeat} heartbeats), so this is a wait and not a freeze. ` +
      (broken.length
        ? `A request it needed did not arrive: ${broken.join('; ')}.`
        : pending.length
          ? `Still fetching: ${pending.join(', ')}.`
          : 'Nothing is outstanding on the network, so it is waiting on something else.');
    code = 1;
  } else if (probe.loopTurns === 0) {
    verdict = 'ALIVE BUT STALLED — callMain returned and the main thread answers, but the browser never handed it back to the page.';
    code = 1;
  } else if (shot && shot.colours > 1) {
    const shown =
      `the canvas shows ${shot.colours} distinct colours in a screenshot of what the browser is actually displaying ` +
      `(${shot.bytes} bytes of PNG), over ${probe.loopTurns} event-loop turns and ${probe.heartbeat} heartbeats.`;
    // A picture on the screen is not the same as a picture a host can use, and the
    // difference is worth a red round: this package ships a canvas, not a tab.
    if (transparent(probe)) {
      verdict = `DRAWING, BUT TRANSPARENT — ${shown}` + alphaNote(probe) + glNote(probe);
      code = 1;
    } else {
      verdict = `DRAWING — ${shown}` + alphaNote(probe) + glNote(probe);
      code = 0;
    }
  } else if (transparent(probe)) {
    // No screenshot to go on — the compositor refused, or the clip failed. The backdrop
    // read still separates "nothing was drawn" from "all of it was drawn at zero alpha",
    // and those are different bugs.
    verdict = `DRAWING, BUT TRANSPARENT — nothing could be screenshotted, but the canvas is not empty.` + alphaNote(probe) + glNote(probe);
    code = 1;
  } else if (shot && shot.colours === 1) {
    // A screenshot cannot tell a canvas cleared to one colour from one never painted at
    // all — an unpainted canvas shows the page behind it, which is also one colour. The
    // GL counters can, and the distinction is worth keeping: one is a renderer that runs
    // and draws nothing, the other never got as far as a surface.
    const cleared = (probe.gl?.clearsToCanvas ?? 0) > 0;
    verdict = cleared
      ? `CLEARED, NOT DRAWN — the canvas is a single flat colour in a screenshot of what the browser is actually displaying, and something cleared it ${probe.gl.clearsToCanvas} times. A renderer owns it and draws nothing on top.`
      : `BLANK — the canvas is a single flat colour in a screenshot of what the browser is actually displaying, and nothing ever cleared it either, over ${probe.loopTurns} event-loop turns.`;
    verdict += glNote(probe);
    code = 1;
  } else if (!probe.pixels || probe.pixels.samples === 0) {
    // Exit 2, not 1. The other verdicts are findings about the port; this one is a
    // finding about the runner, and reporting a broken instrument as a failing build
    // is how a red run gets blamed on the wrong half.
    verdict =
      `NO PICTURE READ — the tab lived (${probe.loopTurns} event-loop turns) but the canvas was never sampled` +
      (probe.pixels?.error
        ? `: ${probe.pixels.error}`
        : '. The instrument failed, so this run says nothing about the port.');
    code = 2;
  } else if (probe.pixels.opaque === 0) {
    verdict =
      `BLANK — callMain returned and the main thread kept turning (${probe.loopTurns} turns), but nothing was ever presented to the canvas across ${probe.pixels.samples} samples. ` +
      (probe.contexts
        ? `${probe.contexts} WebGL context(s) were created, so it asked for a surface and never painted one.`
        : 'No WebGL context was ever created, so it never got as far as asking for a surface.') +
      glNote(probe);
    code = 1;
  } else if (probe.pixels.best <= 1) {
    verdict =
      `CLEARED, NOT DRAWN — the canvas is one flat colour in every one of ${probe.pixels.samples} samples. Something owns a context and clears it; nothing draws on top.` +
      glNote(probe);
    code = 1;
  } else {
    verdict =
      `DRAWING — ${probe.pixels.best} distinct colours on the canvas, and ${probe.pixels.changed} of ${probe.pixels.samples} samples differed from the one before, over ${probe.loopTurns} event-loop turns and ${probe.heartbeat} heartbeats. ` +
      (probe.pixels.changed > 0
        ? 'PPSSPP put a picture on the screen and kept changing it.'
        : 'PPSSPP put a picture on the screen; it did not change while it was watched.');
    code = 0;
  }

  console.log('\n' + '='.repeat(72));
  if (probe) console.log(vitals(probe));
  console.log(verdict);
  console.log('='.repeat(72));

  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## Browser smoke\n\n**${verdict}**\n\n` +
        (probe ? `\`${vitals(probe)}\`\n\n` : '') +
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
