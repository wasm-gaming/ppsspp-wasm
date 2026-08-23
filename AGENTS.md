# Conventions

## Architecture

Check [STACK.md](STACK.md).

## What this repository is

Two things, kept deliberately apart:

- **`src/`** — the contract implementation. TypeScript, no browser needed to test it.
- **`native/`** — how PPSSPP itself becomes a `.wasm`. A pinned upstream revision and
  a patch series; nothing here runs during `make test`.

The seam between them is [`src/module.ts`](src/module.ts). It is not a convenience
type: it is the specification of what the Emscripten build must export, and it is what
lets the whole of `src/` be written, reviewed and released before the emulator
finishes compiling once. **When the native side needs a new capability, it is declared
there first**, then implemented in `native/`, then used.

## Rules that are not style

- **Never widen `src/module.ts` casually.** Every member it declares is a member the
  build has to keep exported through `-sEXPORTED_RUNTIME_METHODS` or an
  `EMSCRIPTEN_KEEPALIVE`. A narrow declaration is a short list of things that can break.
- **`live: true` in [`src/spec.ts`](src/spec.ts) is a promise to the host**, and
  `tests/spec.test.mjs` enforces it: a property advertised as live must have a binding
  in `src/settings.ts` to apply it with. A host acts on `live` by *not* offering the
  restart the change actually needs, so an unbacked `live: true` is a lie with
  consequences.
- **PPSSPP's own names never leak upwards.** A host says `textureFiltering: 'linear'`;
  `src/settings.ts` is the only file that knows this is `3`. Every key and integer in
  there is taken from PPSSPP's `Core/Config.cpp` and `Core/ConfigValues.h` — cite the
  file when adding one, and do not guess a name that "looks right".
- **`default` is declared in `src/spec.ts` and nowhere else.** `EnginePlayBase` seeds
  its state from it, which is what keeps the value the engine boots with and the value
  it advertises from drifting apart.

## Testing

`make test` is the whole of it, and it is three different kinds of check:

| Command | What it proves |
| --- | --- |
| `make typecheck` | The implementation compiles. |
| `make typecheck-tests` | `tests/conformance.ts` — the engine satisfies the contract and is pleasant to drive. `tests/types.test-d.ts` — the things that must *not* compile still do not. |
| `make typecheck-demo` | The demo is a second conformance proof, held to the contract through `checkJs`. |
| `node --test tests/*.test.mjs` | Behaviour: the lifecycle, the settings mapping, the file sniffing. |

The runtime tests drive the real SDK against `tests/fake-module.mjs`. **Prefer adding
to that fake over mocking the SDK**: a test that stubs `PpssppPlay` proves nothing,
while one that stubs the module proves the whole contract implementation.

## Licensing

This repository is **GPL-2.0-or-later**, because PPSSPP is, and the Emscripten glue is
generated from its sources. That is stricter than
[`@wasm-gaming/engine-specs`](https://github.com/wasm-gaming/engine-specs), which is
MIT — the contract is MIT, an implementation of it need not be. Keep PPSSPP's
attribution in `LICENSE.TXT` intact, and do not add a dependency whose licence is
incompatible with GPL-2.0.

## Temporary files and scripts

Use `.tmp/` in the project root; scripts in `.tmp/scripts/`. Both are gitignored.
