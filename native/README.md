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
browser build, and the CMake shape recorded below started as a reading of it. The
patch series in `patches/` is ours, applied to upstream rather than to their fork, so
we track `hrydgard/ppsspp` directly and can offer the work back.

**Read that reference with a date in mind.** It is based on a PPSSPP that still used
SDL2, and upstream has since moved to SDL3 — see below. Anything copied from it has to
be checked against the pinned revision rather than trusted.

## SDL3, not SDL2

At the pinned revision `CMakeLists.txt` does this:

```cmake
find_package(SDL3 QUIET)
if(NOT SDL3_FOUND)
    message(FATAL_ERROR "SDL3 not found. …")
endif()
set(SDL_LIB_TARGET SDL3::SDL3)
find_package(SDL3_ttf QUIET)   # also fatal
```

No SDL2 fallback, and no `USE_SYSTEM_LIBSDL2` option any more — that variable is gone,
so passing it does nothing. This is the first thing an unpatched Emscripten configure
dies on, and it dies before reaching anything interesting.

The good news is that Emscripten carries the ports: `-sUSE_SDL=3` and
`-sUSE_SDL_TTF=3` are real, they are present in the `emscripten/emsdk:5.0.7` image
this workflow uses, they build SDL 3.4.2, and there is a `sdl3-mt` variant so the
threaded build is covered. The caveat is that emscripten's own port script warns
`sdl3 port is still experimental`, and `sdl3_ttf` pulls in freetype and harfbuzz.

**`find_package(SDL3)` will never find them.** An Emscripten port is not a CMake config
package: it is a compile and link flag that puts headers and a static library in place.
So the patch has to short-circuit the block above under `EMSCRIPTEN` — leave
`SDL_LIB_TARGET`/`SDL_TTF_LIB_TARGET` empty, add `-sUSE_SDL=3 -sUSE_SDL_TTF=3` to the
compile *and* link options, and skip the two `find_package` calls entirely. Same for
the `find_package(Wayland)` above it, which an unpatched tree also reaches because
nothing has told it this is not a Linux desktop.

## The build

```bash
make native-checkout    # pinned upstream + patches/ (see UPSTREAM)
make wasm               # emcmake + ninja  →  src/native/{ppsspp.js,.wasm,.data}
make wasm-release       # the same, optimised
```

`emcc` has to be on `PATH` — the CI job runs in `emscripten/emsdk:5.0.7`.
Expect around forty minutes on four cores.

### A round is a whole round

Ninja stops at the first error by default, which on a port this size means a ten-minute
round diagnoses exactly one mistake and hides every other one behind it. `make wasm`
therefore passes `-k 0`, so ninja builds every target whose inputs are ready and reports
*all* the independent failures together; the exit status is still non-zero. Pass
`WASM_KEEP_GOING=` to get the stop-at-first-error behaviour back when bisecting a single
target.

The CI job (`.github/workflows/wasm.yml`) then keeps its whole output as a `build.log`
artifact and writes the `FAILED:` lines into the run summary, because a round with fifty
failures is not something to read by scrolling a web log.

Two things about that job are worth knowing before editing it, because both were learned
the hard way on the first round:

- **The build step names its shell.** A `run:` step's default shell is `bash -e {0}` —
  no `pipefail` — so `make wasm-release | tee build.log` reports `tee`'s exit status, and
  a round with three compile errors comes back **green**. `shell: bash` is what adds
  `-o pipefail`. The job's verdict is then applied by an explicit final step rather than
  by the build step itself.
- **The caches are restored and saved by separate steps.** `actions/cache` saves in a
  post step guarded by `success()`, so on a red round it saves nothing — and while a port
  is in progress, *every* round is red. `actions/cache/restore` plus
  `actions/cache/save` with `if: always()` is what makes a failed round pay for the next
  one, which is the entire point of caching here.

### What the CI job caches, and why it has to

Two caches, holding different things:

- **ccache**, over this project's own object files, wired up through Emscripten's
  `EM_COMPILER_WRAPPER` — which puts ccache in front of the *clang* invocation `emcc`
  finally makes, rather than in front of `emcc`'s Python driver. The upstream tree is
  re-cloned every round, so `CCACHE_BASEDIR` and a `include_file_mtime` sloppiness
  setting are what stop a fresh path and a fresh mtime from counting as a change.
- **`/emsdk/upstream/emscripten/cache`**, holding the toolchain's own libraries: libc,
  libc++, and the SDL3, freetype and harfbuzz ports. None of them ship prebuilt for the
  pthreads + SIMD + exceptions variant this build asks for, so a cold runner builds all
  of them before it reaches a line of PPSSPP.

Both are rolling caches — the key carries the run id and `restore-keys` picks up the
previous round — because a GitHub cache entry is immutable once written, so a fixed key
would freeze the first round's misses forever.

Verified on round 7: 1073 cacheable compiles, all of them misses on a cold runner, 2146
files written. `EM_COMPILER_WRAPPER` does reach the real compiler.

### The shape of the Emscripten branch in CMake

| Choice | Why |
| --- | --- |
| `-sUSE_SDL=3`, `-sUSE_SDL_TTF=3` | PPSSPP's SDL frontend is the one that ports; the Qt and native ones do not. Upstream requires SDL3 — see above. |
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
browser gives says nothing about the cause.

Two things follow from that, and both are done rather than recommended:

- **`src/loader.ts` checks `crossOriginIsolated`** before it imports the glue, and
  throws an error naming both headers. `=== false`, not a falsy test: outside a browser
  the global does not exist, and a Node host driving this package through its own
  loader has no `SharedArrayBuffer` problem to be warned about.
- **The demo carries [`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker)**
  (MIT), copied into `site/demo/` by `make site`. It registers a service worker that
  adds the headers and reloads the page once. It lands beside the page rather than in
  `site/vendor/` because a service worker's default scope is its own directory — one
  served from `/vendor/` would not cover `/demo/`.

Verified in a real Chromium against the built site: the page comes back
`crossOriginIsolated === true` with `SharedArrayBuffer` available, and the demo still
boots its stub afterwards.

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

`patches/` holds the changes as diffs, applied onto the pinned revision by
`make native-checkout`. Keeping them as patches rather than as a vendored tree is what
makes "what do we actually change about PPSSPP?" a question with a short answer, and
what makes offering the work upstream a matter of sending the series.

Rolling forward is: bump `REV` in `UPSTREAM`, run `make native-checkout`, fix whatever
fails to apply, regenerate.

### Patches that land inside a submodule

`git apply --3way` in the PPSSPP worktree cannot touch a file inside one of its
submodules: a submodule is a separate repository, and the parent's object database does
not hold its blobs, so the three-way merge has nothing to merge against. Those patches
live under `patches/submodules/<submodule path>/` instead, and `make native-checkout`
applies each one in that submodule's own worktree. `ext/aemu_postoffice` is the first of
them.

### 0001 — the Emscripten platform

**Status: configures, and all 1118 targets compile.** The flag set is sound and the
whole of PPSSPP now builds under Emscripten; what remains is the link. Every hunk is
guarded by `EMSCRIPTEN`, so no other target changes:

- the platform block itself, which has to sit *before* the `option()` calls because it
  decides their defaults;
- `VULKAN` forced off — Emscripten reports `UNIX`, and leaving Vulkan on is also what
  sends the X11 and Wayland searches after desktop libraries that are not there;
- the SDL3 short-circuit described above;
- the flag block: WebGL2, threads, SIMD, exceptions, memory, `MODULARIZE`,
  `INVOKE_RUN=0`, the runtime methods, the preloaded assets;
- the output name, pinned to `ppsspp.js`. Upstream would emit `PPSSPPSDL.js`, and the
  SDK resolves the glue by a fixed path — a frontend rename upstream must not become a
  broken import downstream;
- `GHC_OS_DETECTED`/`GHC_OS_LINUX`. `ext/armips` vendors ghc::filesystem, which detects
  its host from `__linux__`, `__APPLE__`, `_WIN32` and friends and stops at
  `#error "Operating system currently not supported!"` when it recognises none of them.
  Its detection block is guarded by `GHC_OS_DETECTED`, so saying so from the command
  line picks the POSIX path — and does it without patching a header that lives inside a
  submodule of a submodule, where a patch series cannot reach it cleanly.

Three things were checked against a real `emcc` link rather than assumed, and two of
them came back different from what the reference fork suggested:

- **`INCOMING_MODULE_JS_API` takes only names Emscripten itself knows.** Listing
  `ppssppEvent` or `pthreadPoolSize` there earns `invalid entry` warnings. It does not
  matter: `MODULARIZE` emits `var Module = moduleArg`, so a host's own properties are
  on the module object regardless and are reachable from C++. The list is now the
  runtime's own names only.
- **The runtime pool size works.** `-sPTHREAD_POOL_SIZE=Module['pthreadPoolSize']||…`
  is emitted verbatim into the glue, so `config.threads` genuinely sizes the worker
  pool rather than merely claiming to.
- `-pthread` with `ALLOW_MEMORY_GROWTH` draws a performance warning from emcc
  (non-wasm code runs slowly across a growing heap). Accepted: PPSSPP cannot fit a
  fixed heap, and it needs its threads.

### 0004, 0005 — two more things upstream never compiled

Both are upstream bugs rather than Emscripten ones, found by being the first build to
reach the code: 0004 completes the no-SIMD branch of `Common/Math/CrossSIMD.h`
(`Vec4F32::WithLane3From`, `AnyCompareBitsSet`), and 0005 gives `FakeJit` the
`GetCodeBase()` that `JitInterface` declares pure virtual — without it
`CreateNativeJit()` cannot instantiate the class it falls back to on every
architecture with no native JIT. Both are worth sending upstream on their own, as 0003
is.

### 0006 — the post office links

`ext/aemu_postoffice/client/postoffice.c` is compiled unconditionally and calls into
whichever `sock_impl_*.c` the platform list picks. Emscripten sets `UNIX` but not
`LINUX`, so it picked none, and the link died on `native_close_tcp_sock` and a dozen
like it. It needs the `SO_NOSIGPIPE` fix in the submodule as well — see above.

### What is not done

**Nothing has linked yet.** All 1118 targets compile; the final `ppsspp.js` link is
where the work now is, and `SDL/SDLMain.cpp` is the known obstacle: its main loop
blocks the thread it runs on, which is the one thing a browser's main thread cannot
do. Either `-sPROXY_TO_PTHREAD` or an `emscripten_set_main_loop` rewrite; that
decision is not made yet.

The bridge in the next section is also still unwritten, so nothing exports
`ppsspp_web_*` yet and `-sEXPORTED_FUNCTIONS` is deliberately absent: naming a symbol
that does not exist is a link error.

**Note for anyone building in this repository's own agent sandbox:** the Emscripten
ports (SDL3, SDL3_ttf, freetype, harfbuzz, zlib) are fetched from GitHub *archive*
URLs, and those are refused (HTTP 403) by the sandbox's egress policy while `git`
reads of the same repositories are allowed. A local build is still possible: clone
each project at the tag its port pins into
`<emsdk>/upstream/emscripten/cache/ports/<name>/<expected subdir>` and write the
port's URL into `<...>/ports/<name>/.emscripten_url`, which is the marker
`fetch_port_artifact` checks before downloading anything. CI has no such restriction.

## Known to be missing

- **Video in UMD titles**, with ffmpeg off.
- **Networking** — ad-hoc multiplayer needs a relay, which is a separate piece.
- **Performance**, in general: the IR interpreter is not the JIT, and a browser is not
  a phone. Expect the resolution multiplier to be the lever that decides playability.
