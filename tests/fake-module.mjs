// The stand-in for the Emscripten build.
//
// `src/module.ts` declares what the native side must expose, and this implements that
// declaration in a couple of hundred lines. That is the whole point of routing the
// module through a `PpssppLoader` parameter: the contract implementation can be driven
// end to end — boot, restart, live settings, teardown, failure — in Node, with no
// `.wasm` on disk and no browser. When the real build lands, the only thing that has
// to be true is that it satisfies the same interface this does.

/**
 * A DOM target that is exactly as much of one as `PpssppPlay` touches.
 *
 * Written by hand rather than pulled in as a dependency: the surface is four methods,
 * and a fake we control is what lets a test assert that a *new* canvas was created on
 * restart — the WebGL-context rule — which a real DOM would make no easier to see.
 */
export function fakeTarget() {
  const children = [];
  const ownerDocument = {
    createElement(tag) {
      const element = {
        tagName: tag.toUpperCase(),
        style: {},
        width: 0,
        height: 0,
        tabIndex: -1,
        remove() {
          const at = children.indexOf(element);
          if (at >= 0) children.splice(at, 1);
        },
      };
      return element;
    },
  };
  return {
    ownerDocument,
    children,
    appendChild(child) {
      children.push(child);
      return child;
    },
  };
}

/**
 * @param {object} [options]
 * @param {'ok' | 'error' | 'silent'} [options.boot] What `callMain` leads to. `silent`
 *   models a module that comes up but never reports a boot, so a test can drive the
 *   outcome itself.
 * @param {string} [options.bootError]
 * @param {boolean} [options.brokenShutdown] Model a module that already aborted, so
 *   `close()` has to survive a throwing `ccall` and a dead FS.
 */
export function fakeEngine(options = {}) {
  const { boot = 'ok', bootError = 'native boom', brokenShutdown = false } = options;

  const log = {
    /** Every FS call, in order: `['mount', type, opts, mountpoint]` and friends. */
    fs: [],
    /** Every `ccall`, as `[name, ...args]`. */
    ccalls: [],
    /** The argv of the most recent `callMain`. */
    argv: undefined,
    /** How many modules the loader was asked to build — a restart must make a second. */
    instances: 0,
    terminated: 0,
  };

  let emit;
  let lastInit;
  const waiting = [];

  const loader = async (init) => {
    log.instances += 1;
    lastInit = init;
    emit = init.ppssppEvent;
    for (const resolve of waiting.splice(0)) resolve(init);

    const FS = {
      mkdirTree: (path) => log.fs.push(['mkdirTree', path]),
      writeFile: (path, data) => log.fs.push(['writeFile', path, data]),
      unlink: (path) => log.fs.push(['unlink', path]),
      mount: (type, opts, mountpoint) => log.fs.push(['mount', type, opts, mountpoint]),
      unmount: (mountpoint) => {
        if (brokenShutdown) throw new Error('FS is gone');
        log.fs.push(['unmount', mountpoint]);
      },
      syncfs: (populate, callback) => {
        log.fs.push(['syncfs', populate]);
        // `brokenShutdown` models a module that died *while running*, so reading the
        // memory stick in at boot still works and only the flush on the way out fails.
        const broken = brokenShutdown && populate === false;
        queueMicrotask(() => callback(broken ? new Error('FS is gone') : undefined));
      },
      analyzePath: () => ({ exists: false }),
    };

    return {
      FS,
      IDBFS: 'IDBFS',
      WORKERFS: 'WORKERFS',
      callMain(argv) {
        log.argv = argv;
        // Asynchronous on purpose: the real `callMain` returns as soon as the main
        // loop is registered, and a boot that resolved synchronously would hide any
        // ordering bug between `callMain` and the promise that waits on it.
        queueMicrotask(() => {
          if (boot === 'ok') {
            emit({ type: 'booted', gameId: 'ULUS10041', title: 'Test Game', region: 'US' });
          } else if (boot === 'error') {
            emit({ type: 'error', message: bootError });
          }
        });
      },
      ccall(name, _returnType, _argTypes, args) {
        if (brokenShutdown && name === 'ppsspp_web_shutdown') throw new Error('module aborted');
        log.ccalls.push([name, ...args]);
        return 1;
      },
      PThread: {
        terminateAllThreads() {
          log.terminated += 1;
        },
      },
    };
  };

  return {
    loader,
    log,
    /** Push an event the way the emulator would, once it is running. */
    emit: (event) => emit(event),
    /** What the loader was handed — `canvas`, `pthreadPoolSize`, the callbacks. */
    init: () => lastInit,
    /**
     * The same, but awaitable. `open()` does several `await`s before it reaches the
     * loader, so a test that wants to poke the module mid-boot cannot assume it
     * exists yet — reaching for `init()` too early is how this fake would hand back
     * `undefined` and fail a test for the wrong reason.
     */
    whenLoaded: () =>
      lastInit ? Promise.resolve(lastInit) : new Promise((resolve) => waiting.push(resolve)),
  };
}

/** The bytes written to a path, decoded. Used to read the generated `ppsspp.ini`. */
export function writtenText(log, path) {
  for (let i = log.fs.length - 1; i >= 0; i--) {
    const entry = log.fs[i];
    if (entry[0] === 'writeFile' && entry[1] === path) return new TextDecoder().decode(entry[2]);
  }
  return undefined;
}

/** Every FS call of one kind, in order. */
export function calls(log, kind) {
  return log.fs.filter((entry) => entry[0] === kind);
}
