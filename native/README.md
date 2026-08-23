# The native side

This directory is how PPSSPP itself becomes a `.wasm`. Nothing here runs during
`make test` — the JavaScript in `../src` is written against the interface in
`../src/module.ts` and is tested against a fake, so the contract implementation can be
finished, reviewed and released before the emulator finishes compiling once.

## What upstream gives us, and what it does not

**PPSSPP has no Emscripten support.** Not partial, none: at the pinned revision there
is no `EMSCRIPTEN` branch anywhere in the 1700-line `CMakeLists.txt`, and no file in
the tree is named for wasm or the web. [Issue
#13567](https://github.com/hrydgard/ppsspp/issues/13567) is still a question rather
than a plan. So this is a port, not a configuration.

It is a port that is known to work. The unofficial fork
[`root-hunter/ppsspp-wasm`](https://github.com/root-hunter/ppsspp-wasm) (branch
`wasm`, [live build](https://root-hunter.github.io/ppsspp-web/)) reached a playable
browser build, and the CMake shape recorded below is derived from reading it. That is
the reference; the patch series in `patches/` is ours, applied to upstream rather than
to their fork, so we track `hrydgard/ppsspp` directly and can offer the work back.

## The build

```bash
make native-checkout    # pinned upstream + patches/ (see UPSTREAM)
make wasm               # emcmake + ninja  →  src/native/{ppsspp.js,.wasm,.data}
make wasm-release       # the same, optimised
```

`emcc` has to be on `PATH` — the CI job runs in `emscripten/emsdk:5.0.7`.
Expect around forty minutes on four cores.

### The shape of the Emscripten branch in CMake

| Choice | Why |
| --- | --- |
| `-sUSE_SDL=2` | PPSSPP's SDL frontend is the one that ports; the Qt and native ones do not. |
| `-sMIN_WEBGL_VERSION=2`, `-sMAX_WEBGL_VERSION=2`, `-sFULL_ES3=1` | PPSSPP's GLES3 backend maps onto WebGL2. WebGL1 is not enough for it. |
| `VULKAN=OFF` | No Vulkan in a browser. WebGPU is a later question, not this one. |
| `-pthread`, `-sPTHREAD_POOL_SIZE` | PPSSPP is genuinely multi-threaded. This is what forces cross-origin isolation — see below. |
| `-msimd128` | The software renderer and the texture scalers are the hot paths, and both vectorise. |
| `-fexceptions` | Parts of the codebase and of libzip throw. |
| `-sWASM_BIGINT` | 64-bit values cross the boundary without being split. |
| `-sALLOW_MEMORY_GROWTH`, 512 MB initial / 4 GB max | A PSP title plus its textures does not fit in a small heap, and 4 GB is the wasm32 ceiling. |
| `X86`/`X86_64`/`ARM64` all `OFF` | There is no runtime code generation in WebAssembly, so PPSSPP's JIT cannot exist. The IR interpreter is what runs. |
| `USE_FFMPEG=OFF`, `USE_DISCORD=OFF`, `USE_MINIUPNPC=OFF` | None of the three has a browser story, and each is a large dependency. Video playback in UMD titles is the known casualty. |
| `USE_NO_MMAP=ON` | Emscripten's `mmap` cannot do what PPSSPP's fast-memory path wants. |
| `--preload-file assets@…` | PPSSPP's fonts, shaders and UI atlas have to exist before it starts. |
| `-lworkerfs.js` | How a 1.8 GB ISO is read without being copied into the heap. |

Two flags matter to this package specifically, and are **not** in the reference fork:

- **`-sMODULARIZE=1 -sEXPORT_ES6=1`.** Without them there is one global module and one
  boot per page, and `restart()` cannot work at all. See the note on `main()` below.
- **`-sINVOKE_RUN=0`.** The memory stick has to be mounted and the game staged before
  `main()` looks for either, so this package calls `callMain` itself.

`-sEXPORTED_RUNTIME_METHODS` has to name `callMain`, `ccall`, `FS`, `IDBFS`,
`WORKERFS` and `PThread` — exactly the members `../src/module.ts` declares, and no
more. That file is the specification: if it declares something, the build exports it.

### `main()` runs once

There is no supported way to run an Emscripten `main()` twice. That single fact is why
`MODULARIZE` is required, why `PpssppPlay.open()` disposes of the previous module
before opening, and why every restart builds a **new canvas** — a canvas yields one
WebGL context for its entire lifetime, so the second module could never get one from
the first module's element.

### Cross-origin isolation

Threads mean `SharedArrayBuffer`, which means the page must be served with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

A host that cannot set headers — GitHub Pages, for one — needs a service worker that
injects them. Without isolation the module does not start at all, and the error the
browser gives says nothing about the cause, so a host should check
`crossOriginIsolated` and say so plainly.

## The bridge

This is the whole of the C we add. It is small on purpose: everything else PPSSPP
already does.

```c
// Called from JS. Return values are 1 for accepted, 0 for unknown key.
int  ppsspp_web_apply_setting(const char *key, const char *value);
void ppsspp_web_pause(void);
void ppsspp_web_resume(void);
void ppsspp_web_shutdown(void);
```

`ppsspp_web_apply_setting` takes `Section/Key` in PPSSPP's own ini vocabulary —
`Graphics/InternalResolution`, `Sound/GameVolume` — and applies it to the running
`g_Config`. Keys under the `Web/` section are this package's own and have no ini
entry; the only one so far is `Web/FastForward`, which sets the throttle rather than a
config field. `../src/settings.ts` is the complete list of keys that will ever arrive.

Only what `../src/spec.ts` advertises as `live: true` is ever sent here. Everything
else reaches PPSSPP through the generated `ppsspp.ini` at boot.

### Events, going the other way

One callback, registered on the module before instantiation as `Module.ppssppEvent`,
and called from C++ with a JSON-compatible object:

```js
{ type: 'booted', gameId: 'ULUS10041', title: 'Daxter', region: 'US' }
{ type: 'error',  message: '…' }
{ type: 'exit' }
{ type: 'fps',    fps: 59.94, vps: 60 }
{ type: 'saveState', slot: 2, action: 'saved' }
{ type: 'pause' } | { type: 'resume' }
```

`booted` is the important one: it must be emitted when the first frame is on its way,
not when `main()` starts. `callMain` returns as soon as the main loop is registered,
so `booted` is the only thing that can make `await sdk.start()` mean what a host reads
it to mean. An engine that never emits it leaves `start()` pending forever.

`pause` and `resume` are emitted for PPSSPP's **own** pause menu. The ones this
package triggers through `ppsspp_web_pause` are emitted on the JS side, so the native
side must not emit those too or a host would see each pause twice.

The shape is a plain object rather than a string plus arguments so that the same
channel survives `postMessage` unchanged the day the module moves to a worker.

## The patch series

`patches/` holds the changes as `git format-patch` output, applied onto the pinned
revision by `make native-checkout`. Keeping them as patches rather than as a vendored
tree is what makes "what do we actually change about PPSSPP?" a question with a short
answer, and what makes offering the work upstream a matter of sending the series.

Rolling forward is: bump `REV` in `UPSTREAM`, run `make native-checkout`, fix whatever
fails to apply, regenerate.

## Known to be missing

- **Video in UMD titles**, with ffmpeg off.
- **Networking** — ad-hoc multiplayer needs a relay, which is a separate piece.
- **Performance**, in general: the IR interpreter is not the JIT, and a browser is not
  a phone. Expect the resolution multiplier to be the lever that decides playability.
