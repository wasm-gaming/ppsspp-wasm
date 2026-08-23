# @wasm-gaming/ppsspp-wasm

**PPSSPP as one more engine.** The PlayStation Portable emulator, compiled to
WebAssembly and wrapped in [`@wasm-gaming/engine-specs`](https://github.com/wasm-gaming/engine-specs)
— so a host drives it with the same six calls it uses for every other engine in the
ecosystem, and never learns that this one is PPSSPP.

```js
import { PpssppSDK } from '@wasm-gaming/ppsspp-wasm';

const play = await new PpssppSDK({ config: { internalResolution: 2 } })
  .assets({ game: fileFromPicker })
  .mount(document.querySelector('#stage'))
  .on('gameInfo', (event) => console.log(event.detail.title))
  .start({ stateSlot: 0 });

await play.config({ frameSkip: 1 });   // applies now — the descriptor says it is live
await play.restart({ resume: true });
await play.destroy();
```

## Status

**The contract implementation is finished and tested. The emulator is not built yet.**

Those are two separate pieces of work on purpose, and the seam between them is
[`src/module.ts`](src/module.ts): it declares what the Emscripten build has to export,
and everything in `src/` is written against that declaration. So the SDK is complete,
type-checked against the contract, and driven end to end — boot, restart, live
settings, teardown, failure — by tests that run in Node with no `.wasm` anywhere.

What remains is [`native/`](native/README.md): porting PPSSPP to Emscripten and
implementing the four-function bridge. Upstream has **no Emscripten support at all**,
so that is a port rather than a build flag. It is known to be achievable — the
unofficial fork [`root-hunter/ppsspp-wasm`](https://github.com/root-hunter/ppsspp-wasm)
got there — and `native/README.md` records the whole recipe.

## What a host sees

Four payloads, each a method with two overloads. Called with a patch it writes and
keeps the chain; called with nothing it reads.

```js
sdk.config({ internalResolution: 3 })   // writes, chains
await sdk.config()                      // reads
// → { internalResolution: { value: 3, default: 1, enum: [1,2,3,4,5],
//                           description: 'Multiplier over the PSP native 480×272…',
//                           live: true }, … }
```

The getter answers with a **descriptor per key** — enough to paint a settings screen
without the host knowing a single key name. The [demo](https://wasm-gaming.github.io/ppsspp-wasm/demo/) does exactly that: it
contains no PPSSPP setting names at all, and its panel is generated from what the
engine reports about itself.

| Payload | What PPSSPP puts in it |
| --- | --- |
| `config` | How the emulator runs, surviving a game: resolution, filtering, frame skip, sound, language, which CPU core. |
| `options` | What one session opens with: save slot, whether to resume into it, fast-forward, cheats. |
| `assets` | Files: the game, a save state, a cheat database. |
| `storage` | Where the memory stick lives between visits, and whether it persists at all. |

Beyond the core `start`/`error`/`exit`/`pause`/`resume` that every engine emits, this
one adds `gameInfo`, `fps` and `saveState`.

### Give it a `File`, not bytes

`assets.game` takes `Blob | Uint8Array`, and the choice matters more than it looks:

```js
sdk.assets({ game: picker.files[0] })          // mounted through WORKERFS, read lazily
sdk.assets({ game: new Uint8Array(buffer) })   // copied into the heap, costs its size
```

A PSP ISO runs to 1.8 GB and the WebAssembly heap is capped at 4 GB. Both forms work;
only one of them works for a full-size disc.

## Things that are true of this engine and not of others

Worth knowing before the first surprise:

- **A restart is a whole new module.** An Emscripten `main()` runs exactly once, so
  `restart()` tears the emulator down and builds another — including a new canvas,
  because a canvas yields one WebGL context for its entire lifetime.
- **The page must be cross-origin isolated.** PPSSPP is multi-threaded, threads mean
  `SharedArrayBuffer`, and that means `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. Without them the module does not start,
  and the browser's own error says nothing about why.
- **There is no JIT, and there cannot be.** WebAssembly has no runtime code
  generation, so what runs is PPSSPP's IR interpreter. `config.internalResolution` is
  the lever that decides whether a title is playable.
- **`start()` needs a game.** Booting into PPSSPP's own file browser is not a session
  a host in this ecosystem wants, so it is refused rather than opened.

## Build

```bash
npm install
make build            # tsc → dist/ (cleans first)
make typecheck        # the implementation
make typecheck-tests  # the compile-time conformance suite
make typecheck-demo   # the demo, held to the same contract
make test             # all of the above + the runtime tests
make docs             # typedoc → site/
make site             # reference at /, demo at /demo/
make preview          # serve site/ on :8020
```

And, separately, the emulator:

```bash
make native-checkout  # the pinned PPSSPP revision + native/patches/
make wasm-release     # emcmake + ninja → src/native/  (~40 min, needs emcc)
```

## Releasing

`Release` is a manual workflow: pick a bump, pick a dist-tag. It runs the same checks a
push does, bumps and tags, publishes to npm with provenance, and deploys the site.

The dist-tag defaults to **`next`**, and that is not caution for its own sake. Until
`native/` produces a build, this package is the contract layer alone — `loadPpsspp`
resolves an Emscripten glue that is not in the tarball, so a browser cannot actually
start a session. Publishing to `latest` would make `npm i @wasm-gaming/ppsspp-wasm`
hand someone an engine that cannot run. `latest` belongs to the release that ships the
emulator.

## Conformance

`tests/conformance.ts` drives the engine the way a host would and is type-checked
rather than executed — passing `tsc` *is* the assertion. The negative cases live in
`tests/types.test-d.ts` behind `@ts-expect-error`, which fails if a rejection ever
stops happening. The demo is a second proof, held to the contract through `checkJs`.

Behaviour is tested in Node against `tests/fake-module.mjs`, a stand-in that implements
the `src/module.ts` interface. That is what the seam buys: the lifecycle, the settings
mapping and every failure path are exercised without a browser or a build.

## Licence

**GPL-2.0-or-later**, because PPSSPP is. See [LICENSE.TXT](LICENSE.TXT), which keeps
PPSSPP's own attribution and bundled notices intact.

PPSSPP was created by Henrik Rydgård with code from many contributors. This project is
not affiliated with it. It ships no games, no BIOS, and no copyrighted PSP software.

Note that the contract itself — `@wasm-gaming/engine-specs` — is MIT. The contract is
MIT; an implementation of it need not be.
