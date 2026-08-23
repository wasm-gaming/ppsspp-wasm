# Stack

## The shape of it

```
   host application
        │
        │  @wasm-gaming/engine-specs — the contract. Twelve engines, one API.
        ▼
┌─────────────────────────────────────────────────────────────┐
│  @wasm-gaming/ppsspp-wasm                                   │
│                                                             │
│   PpssppSDK / PpssppPlay      src/ppsspp-wasm.ts            │
│     the four payloads         src/payloads.ts               │
│     the descriptors           src/spec.ts                   │
│     host names → PPSSPP ini   src/settings.ts               │
│     Blob or bytes → a path    src/assets.ts                 │
│                                                             │
│   ══════ src/module.ts ══════  the seam, and the spec       │
│                                                             │
│   src/loader.ts → the generated Emscripten glue             │
└─────────────────────────────────────────────────────────────┘
        │
        ▼
   PPSSPP, compiled by Emscripten:  native/
   SDL3 · WebGL2 · pthreads · IR interpreter
```

Everything above the double line is TypeScript with no runtime dependency beyond the
contract, and is tested in Node against a fake module. Everything below is a
forty-minute C++ build whose artifacts are published as releases, never committed.

## Choices, and what forced them

| Choice | Why |
| --- | --- |
| **Emscripten, SDL3 frontend** | PPSSPP's SDL frontend is the one that ports to the web; Qt and the native shells do not. Upstream requires SDL3 (no SDL2 fallback) and has no Emscripten support at all, so `native/` is a port, not a configuration. Emscripten's `-sUSE_SDL=3` port exists but is marked experimental. |
| **WebGL2, not WebGPU** | PPSSPP's GLES3 backend maps onto WebGL2 today. Vulkan cannot exist in a browser, and a WebGPU backend is a project of its own. |
| **The IR interpreter, no JIT** | WebAssembly has no runtime code generation, so PPSSPP's JIT cannot be built at all. This is the single biggest performance constraint, and it is not one that engineering removes. |
| **pthreads** | PPSSPP is genuinely multi-threaded. The cost is that the page must be cross-origin isolated (COOP/COEP) or the module will not start. |
| **WORKERFS for the game** | A PSP ISO runs to 1.8 GB against a 4 GB wasm heap ceiling. A `Blob` is mounted and read lazily; reading one into memory would cost its size twice before the emulator allocated anything. |
| **IDBFS for the memory stick** | Saves have to survive the tab closing. One mount covers PPSSPP's config, saves and save states. |
| **`-sMODULARIZE=1`, `-sINVOKE_RUN=0`** | An Emscripten `main()` runs once, so `restart()` has to build a second module — and the memory stick must be mounted before `main()` goes looking for it. |
| **A pinned checkout plus patches, not a fork or a vendored tree** | `native/UPSTREAM` is a readable history of which PPSSPP we are on, `native/patches/` is the whole of what we change, and nobody working on the JavaScript pays for a 1 GB clone. |

## Consequences a host has to know about

- **Cross-origin isolation is required.** Without `Cross-Origin-Opener-Policy:
  same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, `SharedArrayBuffer`
  is unavailable and the module never starts. The default loader checks
  `crossOriginIsolated` and refuses with an error naming both headers, rather than
  letting it fail obscurely; a host that cannot set headers can inject them with a
  service worker, as the demo does with `coi-serviceworker`.
- **A restart is expensive.** It is a fresh module, a fresh worker pool and a fresh
  canvas — not a soft reset.
- **No video in UMD titles**, with ffmpeg off. No networking yet.
- **Performance is the open question**, and `config.internalResolution` is the lever
  that decides playability.

## Versions

| | |
| --- | --- |
| Contract | `@wasm-gaming/engine-specs` ^0.3.2 |
| TypeScript | ^5.5, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| Node | 24 in CI; the runtime tests need `File` and `Blob`, so 20+ |
| Emscripten | `emscripten/emsdk:5.0.7` |
| PPSSPP | pinned in [`native/UPSTREAM`](native/UPSTREAM) |
