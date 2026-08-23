// The session lifecycle, driven through the contract exactly as a host would drive it.
//
// Every assertion here is about a rule this package promises and could plausibly
// break: that a restart builds a second module and a second canvas, that an error
// reaches a host both ways, that `exit` fires once however the session ended, and that
// the memory stick is read in before boot and flushed out after.

import test from 'node:test';
import assert from 'node:assert/strict';

import { PpssppSDK } from '../dist/ppsspp-wasm.js';
import { calls, fakeEngine, fakeTarget, writtenText } from './fake-module.mjs';

const INI = '/home/web_user/.config/ppsspp/ppsspp.ini';
const USER_DIR = '/home/web_user/.config/ppsspp';

const game = () => new File([new Uint8Array(64)], 'game.iso');

/** A booted session, which is the starting point of most of what follows. */
async function booted(engineOptions, init) {
  const fake = fakeEngine(engineOptions);
  const target = fakeTarget();
  const sdk = new PpssppSDK({ mount: target, assets: { game: game() }, ...init }, fake.loader);
  const play = await sdk.start();
  return { fake, target, sdk, play };
}

test('start() refuses without a game, both ways, before building anything', async () => {
  const fake = fakeEngine();
  const errors = [];
  const sdk = new PpssppSDK({ mount: fakeTarget(), on: { error: (e) => errors.push(e.detail) } }, fake.loader);

  await assert.rejects(sdk.start(), /nothing to boot/);
  assert.equal(errors.length, 1, 'the rejection is also an event');
  assert.match(errors[0].message, /nothing to boot/);
  assert.equal(fake.log.instances, 0, 'no module is built to discover there is no game');
});

test('start() refuses without a mount target', async () => {
  const fake = fakeEngine();
  const sdk = new PpssppSDK({ assets: { game: game() } }, fake.loader);
  await assert.rejects(sdk.start(), /mount\(target\)/);
  assert.equal(fake.log.instances, 0);
});

test('a boot mounts the memory stick, reads it in, stages the game, then runs main', async () => {
  const { fake, target } = await booted();

  const mounts = calls(fake.log, 'mount');
  assert.deepEqual(
    mounts.map((entry) => [entry[1], entry[3]]),
    [
      ['IDBFS', USER_DIR],
      ['WORKERFS', '/game'],
    ],
    'the memory stick and the game, in that order',
  );

  const syncs = calls(fake.log, 'syncfs');
  assert.deepEqual(syncs[0], ['syncfs', true], 'the browser copy is read in before boot');

  assert.deepEqual(fake.log.argv, ['ppsspp', '/game/game.iso']);
  assert.equal(target.children.length, 1, 'one canvas, in the host element');
  assert.equal(target.children[0].tagName, 'CANVAS');
});

test('a Blob game is mounted, never copied', async () => {
  const { fake } = await booted();
  const workerfs = calls(fake.log, 'mount').find((entry) => entry[1] === 'WORKERFS');
  assert.ok(workerfs, 'a Blob goes through WORKERFS');
  assert.equal(workerfs[2].blobs[0].name, 'game.iso');
  const writes = calls(fake.log, 'writeFile').map((entry) => entry[1]);
  assert.ok(!writes.some((path) => path.startsWith('/game/')), 'and is never written into MEMFS');
});

test('a Uint8Array game is written instead, and its format is sniffed', async () => {
  const fake = fakeEngine();
  // `CISO` at offset 0 is a compressed ISO, whatever anyone chose to call it.
  const bytes = new Uint8Array(64);
  bytes.set([0x43, 0x49, 0x53, 0x4f]);
  const sdk = new PpssppSDK({ mount: fakeTarget(), assets: { game: bytes } }, fake.loader);
  await sdk.start();

  assert.equal(fake.log.argv[1], '/game/game.cso');
  const write = calls(fake.log, 'writeFile').find((entry) => entry[1] === '/game/game.cso');
  assert.ok(write, 'bytes are copied into MEMFS');
  assert.ok(!calls(fake.log, 'mount').some((entry) => entry[1] === 'WORKERFS'));
});

test('the generated ini carries the contract state, in PPSSPP\'s own vocabulary', async () => {
  const { fake } = await booted(undefined, {
    config: { internalResolution: 3, textureFiltering: 'linear', volume: 5 },
    options: { stateSlot: 2, resume: true },
  });

  const ini = writtenText(fake.log, INI);
  assert.match(ini, /\[Graphics\]/);
  assert.match(ini, /InternalResolution = 3/);
  assert.match(ini, /TextureFiltering = 3/, 'linear is 3, per Core/ConfigValues.h');
  assert.match(ini, /GameVolume = 5/);
  assert.match(ini, /CPUCore = 2/, 'the IR interpreter, since wasm has no JIT');
  assert.match(ini, /AutoLoadSaveState = 5/, 'resume into slot 2 is 3 + 2');
  assert.ok(!/Web\//.test(ini), "this package's own keys never reach the ini");
});

test('the ini is written after the memory stick is read in, so contract state wins', async () => {
  const { fake } = await booted();
  const order = fake.log.fs.map((entry) => `${entry[0]}:${entry[1]}`);
  const populated = order.indexOf('syncfs:true');
  const wroteIni = order.indexOf(`writeFile:${INI}`);
  assert.ok(populated >= 0 && wroteIni >= 0);
  assert.ok(populated < wroteIni, 'otherwise a stale persisted ini would overwrite it');
});

test('restart builds a second module and a second canvas', async () => {
  const { fake, target, play } = await booted();
  const first = fake.init().canvas;

  await play.restart({ stateSlot: 3 });

  assert.equal(fake.log.instances, 2, 'an Emscripten module runs main() once, so a restart is a new one');
  assert.notEqual(fake.init().canvas, first, 'a canvas yields one WebGL context for its whole life');
  assert.equal(target.children.length, 1, 'and the spent one is gone from the DOM');
  assert.equal(fake.log.terminated, 1, 'the first module\'s worker pool was wound down');
});

test('a live change is applied now; a non-live one waits for the next boot', async () => {
  const { fake, play } = await booted();
  fake.log.ccalls.length = 0;

  await play.config({ internalResolution: 4 });
  assert.deepEqual(
    fake.log.ccalls,
    [['ppsspp_web_apply_setting', 'Graphics/InternalResolution', '4']],
    'internalResolution is advertised live, so it is applied live',
  );

  fake.log.ccalls.length = 0;
  await play.config({ cpuCore: 'interpreter' });
  assert.deepEqual(fake.log.ccalls, [], 'cpuCore is not live — switching cores mid-game is not safe');

  // But it is still state, so the next boot boots with it.
  await play.restart();
  assert.match(writtenText(fake.log, INI), /CPUCore = 0/);
});

test('fastForward reaches the bridge under this package\'s own namespace', async () => {
  const { fake, play } = await booted();
  fake.log.ccalls.length = 0;
  await play.options({ fastForward: true });
  assert.deepEqual(fake.log.ccalls, [['ppsspp_web_apply_setting', 'Web/FastForward', 'True']]);
});

test('destroy flushes the memory stick, winds the threads down, and emits exit once', async () => {
  const exits = [];
  const fake = fakeEngine();
  const target = fakeTarget();
  const sdk = new PpssppSDK({ mount: target, assets: { game: game() } }, fake.loader);
  sdk.on('exit', () => exits.push(1));
  const play = await sdk.start();

  await play.destroy();

  assert.deepEqual(calls(fake.log, 'syncfs').at(-1), ['syncfs', false], 'the flush that makes a save survive');
  assert.deepEqual(calls(fake.log, 'unmount'), [['unmount', USER_DIR]]);
  assert.equal(fake.log.terminated, 1);
  assert.equal(target.children.length, 0, 'the canvas goes with it');
  assert.equal(exits.length, 1);

  await play.destroy();
  assert.equal(exits.length, 1, 'exit fires once, however many times it is asked for');
});

test('persist: false leaves nothing behind', async () => {
  const { fake, play } = await booted(undefined, { storage: { persist: false } });
  await play.destroy();
  assert.ok(
    !calls(fake.log, 'syncfs').some((entry) => entry[1] === false),
    'nothing is written back to IndexedDB',
  );
});

test('the emulator quitting on its own is the same ending, emitted once', async () => {
  const exits = [];
  const { fake, play, sdk } = await booted();
  sdk.on('exit', () => exits.push(1));

  fake.emit({ type: 'exit' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(exits.length, 1);
  assert.deepEqual(calls(fake.log, 'unmount'), [['unmount', USER_DIR]], 'it was a real teardown');

  await play.destroy();
  assert.equal(exits.length, 1, 'and a host destroying afterwards does not double it');
});

test('a boot failure rejects the chain and emits error', async () => {
  const errors = [];
  const fake = fakeEngine({ boot: 'error', bootError: 'no disc' });
  const sdk = new PpssppSDK({ mount: fakeTarget(), assets: { game: game() } }, fake.loader);
  // Registered on the factory, before there is an engine — the case the contract
  // exists to make possible.
  sdk.on('error', (event) => errors.push(event.detail));

  await assert.rejects(sdk.start(), /no disc/);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /no disc/);
});

test('an error after boot still reaches a host, with nothing left to reject', async () => {
  const errors = [];
  const { fake, sdk } = await booted();
  sdk.on('error', (event) => errors.push(event.detail));

  fake.emit({ type: 'error', message: 'GPU lost' });

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /GPU lost/);
});

test('an abort inside Emscripten is a boot failure, not a hang', async () => {
  const fake = fakeEngine({ boot: 'silent' });
  const sdk = new PpssppSDK({ mount: fakeTarget(), assets: { game: game() } }, fake.loader);
  const started = sdk.start();
  // Emscripten's own fatal path, which never goes through `ppssppEvent`.
  const init = await fake.whenLoaded();
  init.onAbort('out of memory');
  await assert.rejects(started, /aborted — out of memory/);
});

test('the engine survives tearing down a module that already died', async () => {
  const fake = fakeEngine({ brokenShutdown: true });
  const sdk = new PpssppSDK({ mount: fakeTarget(), assets: { game: game() } }, fake.loader);
  const play = await sdk.start();
  // Neither the throwing `ccall` nor the dead FS may cost the thread teardown.
  await play.destroy();
  assert.equal(fake.log.terminated, 1);
});

test('pause and resume are this engine\'s own methods, emitting the core events', async () => {
  const seen = [];
  const { fake, play, sdk } = await booted();
  sdk.on('pause', (event) => seen.push(['pause', event.detail.owner]));
  sdk.on('resume', (event) => seen.push(['resume', event.detail.owner]));

  play.pause();
  play.resume();
  // PPSSPP's own pause menu reports the same pair, and a host cannot tell them apart
  // except by who owns them.
  fake.emit({ type: 'pause' });

  assert.deepEqual(seen, [['pause', 'host'], ['resume', 'host'], ['pause', 'ppsspp']]);
  assert.deepEqual(
    fake.log.ccalls.filter(([name]) => name.startsWith('ppsspp_web_p') || name.startsWith('ppsspp_web_r')),
    [['ppsspp_web_pause'], ['ppsspp_web_resume']],
  );
});

test('what the emulator learns at boot reaches the host as an event', async () => {
  const seen = [];
  const fake = fakeEngine();
  const sdk = new PpssppSDK({ mount: fakeTarget(), assets: { game: game() } }, fake.loader);
  sdk.on('gameInfo', (event) => seen.push(event.detail));
  sdk.on('fps', (event) => seen.push(event.detail));

  await sdk.start();
  fake.emit({ type: 'fps', fps: 59.94, vps: 60 });

  assert.deepEqual(seen, [
    { id: 'ULUS10041', title: 'Test Game', region: 'US' },
    { fps: 59.94, vps: 60 },
  ]);
});

test('the worker pool follows config, and 0 asks the machine', async () => {
  const { fake } = await booted(undefined, { config: { threads: 6 } });
  assert.equal(fake.init().pthreadPoolSize, 6);

  const auto = await booted(undefined, { config: { threads: 0 } });
  assert.ok(auto.fake.init().pthreadPoolSize >= 4, 'never fewer than four');
});

test('a save state has to keep the name PPSSPP finds it by', async () => {
  const fake = fakeEngine();
  const sdk = new PpssppSDK(
    { mount: fakeTarget(), assets: { game: game(), saveState: new Blob([new Uint8Array(8)]) } },
    fake.loader,
  );
  await assert.rejects(sdk.start(), /keeping PPSSPP's own name/);

  const named = fakeEngine();
  const ok = new PpssppSDK(
    {
      mount: fakeTarget(),
      assets: { game: game(), saveState: new File([new Uint8Array(8)], 'ULUS10041_1.00.ppst') },
    },
    named.loader,
  );
  await ok.start();
  assert.ok(
    calls(named.log, 'writeFile').some(
      (entry) => entry[1] === `${USER_DIR}/PSP/PPSSPP_STATE/ULUS10041_1.00.ppst`,
    ),
  );
});
