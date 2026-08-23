// Invariants between what this engine *declares* and what it can actually do.
//
// The type system already checks that every payload key has a descriptor. What it
// cannot check is whether a descriptor tells the truth — and `live` is the one that
// matters, because a host acts on it: a property advertised as live is one the host
// will change without offering the restart it silently needs.

import test from 'node:test';
import assert from 'node:assert/strict';

import { spec, CONFIG_BINDINGS, OPTION_BINDINGS, toIni, resolve, autoLoadSaveState } from '../dist/ppsspp-wasm.js';

test('every live config or option has something to apply it with', () => {
  for (const [kind, bindings] of [
    ['config', CONFIG_BINDINGS],
    ['options', OPTION_BINDINGS],
  ]) {
    for (const [key, property] of Object.entries(spec[kind])) {
      if (!property.live) continue;
      assert.ok(
        bindings[key],
        `${kind}.${key} is advertised live but has no binding — a host would change it and nothing would happen`,
      );
    }
  }
});

test('the bindings and the spec describe the same properties', () => {
  for (const [kind, bindings] of [
    ['config', CONFIG_BINDINGS],
    ['options', OPTION_BINDINGS],
  ]) {
    assert.deepEqual(
      Object.keys(bindings).sort(),
      Object.keys(spec[kind]).sort(),
      `${kind}: a binding for a property that does not exist, or a property nothing can reach`,
    );
  }
});

test('every declared default is one of the declared choices', () => {
  for (const payload of Object.values(spec)) {
    for (const [key, property] of Object.entries(payload)) {
      if (!property.enum || property.default === undefined) continue;
      assert.ok(
        property.enum.includes(property.default),
        `${key}: the default is not in its own enum`,
      );
    }
  }
});

test('config and options are fully defaulted; assets are not', () => {
  for (const kind of ['config', 'options', 'storage']) {
    for (const [key, property] of Object.entries(spec[kind])) {
      assert.notEqual(property.default, undefined, `${kind}.${key} boots with no value`);
    }
  }
  for (const [key, property] of Object.entries(spec.assets)) {
    // Unset is the honest answer for a file nobody handed over. A default here would
    // be a made-up one, and `EnginePlayBase` would seed state from it.
    assert.equal(property.default, undefined, `assets.${key} invents a default`);
  }
});

test('every asset says what a file picker should accept', () => {
  for (const [key, property] of Object.entries(spec.assets)) {
    assert.ok(property.allowedTypes?.length, `assets.${key} tells a host nothing about what it takes`);
  }
});

test("this package's own bridge keys never reach PPSSPP's ini", () => {
  const web = resolve(OPTION_BINDINGS, { fastForward: true, stateSlot: 1 });
  assert.ok(web.some((setting) => setting.section === 'Web'), 'the setting resolves');
  assert.ok(!toIni(web).includes('FastForward'), 'but PPSSPP is never asked to store it');
  assert.match(toIni(web), /\[General\]\nStateSlot = 1/, 'while a real one is');
});

test('resume and stateSlot collapse into the one number PPSSPP reads', () => {
  assert.deepEqual(autoLoadSaveState({ resume: false, stateSlot: 3 }), {
    section: 'General',
    key: 'AutoLoadSaveState',
    value: '0',
  });
  // Core/Config.h: "3+ = slot number + 3".
  assert.equal(autoLoadSaveState({ resume: true, stateSlot: 0 }).value, '3');
  assert.equal(autoLoadSaveState({ resume: true, stateSlot: 4 }).value, '7');
});

test('resolve skips what nothing is bound to and what nobody set', () => {
  // `threads` sizes the worker pool; it is not a PPSSPP setting and must not become one.
  assert.deepEqual(resolve(CONFIG_BINDINGS, { threads: 8 }), []);
  assert.deepEqual(resolve(CONFIG_BINDINGS, { volume: undefined }), []);
  assert.deepEqual(resolve(CONFIG_BINDINGS, { volume: 3 }), [
    { section: 'Sound', key: 'GameVolume', value: '3' },
  ]);
});

test('booleans reach the ini in the spelling PPSSPP writes', () => {
  const ini = toIni(resolve(CONFIG_BINDINGS, { soundEnabled: true, autoFrameSkip: false }));
  assert.match(ini, /Enable = True/);
  assert.match(ini, /AutoFrameSkip = False/);
});

test('an ini groups its sections rather than repeating them', () => {
  const ini = toIni(
    resolve(CONFIG_BINDINGS, { internalResolution: 2, frameSkip: 1, soundEnabled: true }),
  );
  assert.equal(ini.match(/\[Graphics\]/g).length, 1);
  assert.match(ini, /\[Graphics\]\nInternalResolution = 2\nFrameSkip = 1/);
});
