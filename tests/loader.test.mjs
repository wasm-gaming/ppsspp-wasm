// The default loader's one pre-flight.
//
// The rest of the loader cannot be tested here — it imports the generated Emscripten
// glue, which is a forty-minute build away and deliberately absent from a clean tree.
// This check runs *before* that import precisely so it can fail with a message about
// headers rather than with a module resolution error, and that ordering is the thing
// worth pinning down.

import test from 'node:test';
import assert from 'node:assert/strict';

import { loadPpsspp } from '../dist/ppsspp-wasm.js';

/** Whatever the value was, put it back: the other test files share this process. */
function withIsolation(value, body) {
  const had = Object.hasOwn(globalThis, 'crossOriginIsolated');
  const before = globalThis.crossOriginIsolated;
  Object.defineProperty(globalThis, 'crossOriginIsolated', { value, configurable: true });
  try {
    return body();
  } finally {
    if (had) {
      Object.defineProperty(globalThis, 'crossOriginIsolated', { value: before, configurable: true });
    } else {
      delete globalThis.crossOriginIsolated;
    }
  }
}

const init = () => ({ canvas: {}, pthreadPoolSize: 4 });

test('a page that is not cross-origin isolated is refused, and told why', async () => {
  await withIsolation(false, async () => {
    await assert.rejects(loadPpsspp(init()), (error) => {
      assert.match(error.message, /not cross-origin isolated/);
      // The two headers are the actionable part: an error that says "SharedArrayBuffer
      // is unavailable" and stops there sends a host looking in the wrong place.
      assert.match(error.message, /Cross-Origin-Opener-Policy: same-origin/);
      assert.match(error.message, /Cross-Origin-Embedder-Policy: require-corp/);
      return true;
    });
  });
});

test('outside a browser the check is inert — an absent global is not a failed one', async () => {
  // Node does not define crossOriginIsolated at all. The loader must not read that as
  // "not isolated", or every non-browser host of this package would be refused before
  // it got anywhere near a module.
  assert.equal(globalThis.crossOriginIsolated, undefined);
  // It gets past the check and dies on the missing glue instead, which is the correct
  // failure for a tree where native/ has never been built.
  await assert.rejects(loadPpsspp(init()), (error) => {
    assert.doesNotMatch(error.message, /cross-origin isolated/);
    return true;
  });
});
