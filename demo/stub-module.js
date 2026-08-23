// @ts-check
/**
 * A `PpssppLoader` that is not PPSSPP.
 *
 * The emulator is a forty-minute Emscripten build that this repository does not commit
 * (see `native/README.md`), and the demo is about the *contract*: what a host can see
 * and drive without knowing which engine it is talking to. So the demo injects this
 * where the real module goes, and everything above it — the settings screen painted
 * from descriptors, the lifecycle, the events, the file picker driven by
 * `allowedTypes` — is the real code path, running the real SDK.
 *
 * It is also a second proof that the seam in `src/module.ts` is implementable, and it
 * is held to that interface by `demo/tsconfig.json`'s `checkJs`: if the declaration
 * grows a member, this stops compiling.
 *
 * What it is NOT is a claim that PPSSPP works. Nothing here emulates anything.
 */

/**
 * @typedef {import('../src/module.js').PpssppLoader} PpssppLoader
 * @typedef {import('../src/module.js').PpssppModule} PpssppModule
 * @typedef {import('../src/module.js').PpssppFS} PpssppFS
 * @typedef {import('../src/module.js').PpssppNativeEvent} PpssppNativeEvent
 */

/** Draws something recognisably alive, so the lifecycle is visible rather than described. */
function painter(/** @type {HTMLCanvasElement} */ canvas) {
  const context = canvas.getContext('2d');
  let frame = 0;
  let raf = 0;
  let running = false;

  const draw = () => {
    if (!context) return;
    frame += 1;
    const { width, height } = canvas;
    context.fillStyle = '#0b0d12';
    context.fillRect(0, 0, width, height);

    // A moving bar, so a paused engine is obviously paused.
    const x = (frame * 2) % (width + 80);
    const gradient = context.createLinearGradient(x - 80, 0, x, 0);
    gradient.addColorStop(0, 'rgba(88,166,255,0)');
    gradient.addColorStop(1, 'rgba(88,166,255,0.85)');
    context.fillStyle = gradient;
    context.fillRect(x - 80, 0, 80, height);

    context.fillStyle = '#8b949e';
    context.font = '11px ui-monospace, monospace';
    context.textAlign = 'center';
    context.fillText('no emulator here — this is the contract, not PPSSPP', width / 2, height / 2 - 6);
    context.fillText(`frame ${frame}`, width / 2, height / 2 + 12);

    if (running) raf = requestAnimationFrame(draw);
  };

  return {
    start() {
      if (running) return;
      running = true;
      draw();
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
  };
}

/**
 * A file system that records rather than stores. The demo prints what it was asked to
 * do, which is the interesting part: where the memory stick is mounted, when it is
 * read in, what the generated ini says.
 *
 * @param {(line: string) => void} log
 * @returns {PpssppFS}
 */
function stubFS(log) {
  const decoder = new TextDecoder();
  return {
    mkdirTree: (path) => log(`FS mkdir ${path}`),
    writeFile: (path, data) => {
      log(`FS write ${path} (${data.byteLength} bytes)`);
      if (path.endsWith('.ini')) log(`\n${decoder.decode(data).trim()}\n`);
    },
    unlink: (path) => log(`FS unlink ${path}`),
    mount: (type, options, mountpoint) => {
      const blobs = /** @type {{ blobs?: { name: string }[] }} */ (options).blobs;
      const what = blobs ? ` [${blobs.map((blob) => blob.name).join(', ')}]` : '';
      log(`FS mount ${String(type)} at ${mountpoint}${what}`);
    },
    unmount: (mountpoint) => log(`FS unmount ${mountpoint}`),
    syncfs: (populate, callback) => {
      log(`FS syncfs ${populate ? 'in (read the browser copy)' : 'out (flush to IndexedDB)'}`);
      setTimeout(() => callback(), 0);
    },
    analyzePath: () => ({ exists: false }),
  };
}

/**
 * @param {(line: string) => void} log
 * @returns {PpssppLoader}
 */
export function stubLoader(log) {
  return async (init) => {
    log(`module built — pool of ${init.pthreadPoolSize} workers`);
    const paint = painter(init.canvas);
    /** @type {(event: PpssppNativeEvent) => void} */
    const emit = init.ppssppEvent ?? (() => {});
    let ticker = 0;

    /** @type {PpssppModule} */
    const module = {
      FS: stubFS(log),
      IDBFS: 'IDBFS',
      WORKERFS: 'WORKERFS',
      callMain(argv) {
        log(`callMain ${argv.join(' ')}`);
        // Asynchronous, as the real one is: `callMain` returns when the main loop is
        // registered, and `booted` is what actually resolves `start()`.
        setTimeout(() => {
          paint.start();
          emit({ type: 'booted', gameId: 'DEMO00001', title: 'Contract Demo', region: 'EU' });
          ticker = setInterval(() => emit({ type: 'fps', fps: 59.94, vps: 60 }), 2000);
        }, 400);
      },
      ccall: /** @type {PpssppModule['ccall']} */ (
        (/** @type {string} */ name, /** @type {unknown} */ _r, /** @type {unknown} */ _t, /** @type {string[]} */ args) => {
          log(`ccall ${name}${args.length ? ` ${args.join(' = ')}` : ''}`);
          if (name === 'ppsspp_web_pause') paint.stop();
          if (name === 'ppsspp_web_resume') paint.start();
          if (name === 'ppsspp_web_shutdown') {
            paint.stop();
            clearInterval(ticker);
          }
          return 1;
        }
      ),
      PThread: {
        terminateAllThreads() {
          log('worker pool wound down');
        },
      },
    };
    return module;
  };
}
