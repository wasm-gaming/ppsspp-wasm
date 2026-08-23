.PHONY: build typecheck typecheck-tests typecheck-demo test docs site preview preview-stop \
        native-checkout native-clean wasm wasm-release wasm-config wasm-build publish publish-dry-run

PORT ?= 8020

TSC := ./node_modules/.bin/tsc
TYPEDOC := ./node_modules/.bin/typedoc

# ---- The JavaScript side: the contract implementation ----

# `tsc` never removes output whose source is gone, so a deleted module would survive
# in dist/ and get published. Clean first, always.
#
# The emulator artifacts are copied in afterwards rather than being built into dist/
# directly, precisely because of that `rm -rf`: `src/native/` is where a forty-minute
# wasm build leaves its output, and a `make build` must not destroy it. `src/loader.ts`
# resolves the glue relative to itself, so once compiled it looks in `dist/native/` —
# which is why this copy is load-bearing rather than tidy.
build:
	rm -rf dist
	$(TSC) -p tsconfig.json
	@if [ -d src/native ]; then \
		mkdir -p dist/native && cp src/native/* dist/native/ && \
		echo "Copied the emulator artifacts into dist/native/."; \
	else \
		echo "No src/native/ — publishing the contract layer without the emulator (see native/README.md)."; \
	fi

typecheck:
	$(TSC) -p tsconfig.json --noEmit

# The compile-time conformance suite: tests/conformance.ts drives the engine the way a
# host would, and tests/types.test-d.ts asserts what must NOT compile. Passing tsc IS
# the assertion — there is nothing to run.
typecheck-tests:
	$(TSC) -p tests/tsconfig.json

# The demo is held to the same contract through checkJs, so "the demo conforms" is
# verified rather than claimed.
typecheck-demo:
	$(TSC) -p demo/tsconfig.json

test: build typecheck-tests typecheck-demo
	node --test tests/*.test.mjs

# ---- The native side: PPSSPP itself ----
#
# None of this runs in the normal build. The emulator is a ~40 minute Emscripten
# compile producing tens of megabytes of artifacts that are published as releases and
# never committed, so `make test` deliberately does not depend on it.

UPSTREAM_URL := $(shell sed -n 's/^URL=//p' native/UPSTREAM)
UPSTREAM_REV := $(shell sed -n 's/^REV=//p' native/UPSTREAM)
NATIVE_DIR ?= native/ppsspp

WASM_BUILD_DIR ?= build-wasm
WASM_INITIAL_MEMORY ?= 536870912
WASM_MAXIMUM_MEMORY ?= 4294967296
WASM_JOBS ?= -j$(shell nproc 2>/dev/null || echo 4)
CMAKE ?= cmake

# Ninja stops the entire build at the first error. On a port of this size that means a
# round costs ten minutes and buys exactly one diagnosis, while every target that was
# already going to fail stays hidden behind it. `-k 0` builds everything whose inputs
# are ready and collects *all* the independent failures in one go; the exit status is
# still non-zero, so nothing downstream mistakes a failed build for a good one.
#
# Set it empty to get the stop-at-first-error behaviour back: `make wasm WASM_KEEP_GOING=`.
WASM_KEEP_GOING ?= -k 0

# Fetch the pinned upstream commit and apply this project's patch series onto it.
# `--filter=blob:none` because a full PPSSPP history is around a gigabyte and the
# build needs one revision of it.
native-checkout:
	@if [ ! -d "$(NATIVE_DIR)/.git" ]; then \
		git clone --filter=blob:none --no-checkout "$(UPSTREAM_URL)" "$(NATIVE_DIR)"; \
	fi
	git -C "$(NATIVE_DIR)" fetch --filter=blob:none origin "$(UPSTREAM_REV)"
	git -C "$(NATIVE_DIR)" checkout --force --detach "$(UPSTREAM_REV)"
	@# --force so a second run resets a worktree the submodule patches below dirtied,
	@# which is what makes `make native-checkout` repeatable rather than one-shot.
	git -C "$(NATIVE_DIR)" submodule update --init --recursive --force --depth 1
	@# The patch series is the whole of what this project changes about PPSSPP.
	@if ls native/patches/*.patch >/dev/null 2>&1; then \
		git -C "$(NATIVE_DIR)" apply --3way $(addprefix $(CURDIR)/,$(wildcard native/patches/*.patch)); \
		echo "Applied $(words $(wildcard native/patches/*.patch)) patch(es)."; \
	else \
		echo "No patches in native/patches/ — see native/README.md."; \
	fi
	@# A patch that lands inside a submodule cannot go through the apply above: a
	@# submodule is a separate repository, and the parent's object database does not
	@# have its blobs, so --3way has nothing to merge against. Those patches live under
	@# native/patches/submodules/<submodule path>/ and are applied in the submodule's
	@# own worktree instead.
	@find native/patches/submodules -name '*.patch' 2>/dev/null | sort | while read -r patch; do \
		sub=$$(dirname "$${patch#native/patches/submodules/}"); \
		if [ ! -d "$(NATIVE_DIR)/$$sub" ]; then \
			echo "No submodule at $$sub for $$patch — has it been renamed upstream?" >&2; \
			exit 1; \
		fi; \
		git -C "$(NATIVE_DIR)/$$sub" apply --3way "$(CURDIR)/$$patch" || exit 1; \
		echo "Applied $$(basename "$$patch") in $$sub."; \
	done

native-clean:
	rm -rf "$(NATIVE_DIR)" "$(WASM_BUILD_DIR)"

# The flags are explained in native/README.md; the short version is that PPSSPP runs
# on SDL3 over WebGL2, with threads, SIMD and exceptions, and no JIT.
#
# The SDL3 wiring is NOT here. `-sUSE_SDL=3` is a compiler flag, not a cache variable,
# and upstream reaches SDL through `find_package(SDL3)` — which will never find an
# Emscripten port. Teaching it to is part of the patch series, not of this invocation.
WASM_CMAKE_ARGS := \
	-G Ninja \
	-DUSING_GLES2=ON \
	-DUSING_EGL=OFF \
	-DVULKAN=OFF \
	-DUSE_NO_MMAP=ON \
	-DUSE_FFMPEG=OFF \
	-DUSE_DISCORD=OFF \
	-DUSE_MINIUPNPC=OFF \
	-DUSE_SYSTEM_LIBPNG=OFF \
	-DUSE_SYSTEM_FREETYPE=OFF \
	-DUSE_SYSTEM_LIBZIP=OFF \
	-DWASM_INITIAL_MEMORY=$(WASM_INITIAL_MEMORY) \
	-DWASM_MAXIMUM_MEMORY=$(WASM_MAXIMUM_MEMORY)

wasm-config:
	emcmake $(CMAKE) -S "$(NATIVE_DIR)" -B "$(WASM_BUILD_DIR)" $(WASM_CMAKE_ARGS) \
		-DCMAKE_BUILD_TYPE=$(if $(RELEASE),Release,RelWithDebInfo)

wasm-build:
	$(CMAKE) --build "$(WASM_BUILD_DIR)" $(WASM_JOBS) -- $(WASM_KEEP_GOING)
	@# The loader resolves the glue relative to itself, so the artifacts land beside it.
	mkdir -p src/native
	cp "$(WASM_BUILD_DIR)"/ppsspp.js "$(WASM_BUILD_DIR)"/ppsspp.wasm src/native/
	@[ -f "$(WASM_BUILD_DIR)/ppsspp.data" ] && cp "$(WASM_BUILD_DIR)/ppsspp.data" src/native/ || true

wasm: native-checkout wasm-config wasm-build

wasm-release:
	$(MAKE) wasm RELEASE=1

# ---- Docs and the demo site ----

docs:
	$(TYPEDOC)

# The whole Pages site: reference at the root, demo under /demo/.
#
# `site/src/` is not a stray copy of the sources. The demo imports the SDK from
# `../src/ppsspp-wasm.js` as a *value*, and a value import is not erased the way the
# JSDoc type imports beside it are: the browser really fetches that path. With the demo
# at `site/demo/`, it resolves to `site/src/`, so the built JS has to be there.
site: docs build
	mkdir -p site/demo site/src site/vendor
	cp -R demo/. site/demo/
	rm -f site/demo/tsconfig.json
	cp dist/*.js site/src/
	# The SDK imports the contract by name. A browser cannot resolve a bare specifier,
	# so the demo carries an import map pointing at this copy — see demo/index.html.
	cp node_modules/@wasm-gaming/engine-specs/dist/engine-specs.js site/vendor/
	touch site/.nojekyll

# A previous preview left running holds the port, and python's own error for that says
# nothing about what to do.
preview: site
	@lsof -nP -iTCP:$(PORT) -sTCP:LISTEN >/dev/null 2>&1 && { \
		echo "Port $(PORT) is already serving — a previous \`make preview\` is still running:"; \
		lsof -nP -iTCP:$(PORT) -sTCP:LISTEN | tail -n +2; \
		echo "Stop it with \`make preview-stop\`, or use \`make preview PORT=8021\`."; \
		exit 1; \
	} || true
	@echo "Reference: http://localhost:$(PORT)/    Demo: http://localhost:$(PORT)/demo/"
	python3 -m http.server $(PORT) --directory site

preview-stop:
	@pids=$$(lsof -ti TCP:$(PORT) -sTCP:LISTEN); \
	if [ -n "$$pids" ]; then \
		kill $$pids && echo "Stopped the server on port $(PORT) (pid $$pids)."; \
	else \
		echo "Nothing listening on port $(PORT)."; \
	fi

publish: typecheck test
	npm publish --access public

publish-dry-run: typecheck test
	npm publish --access public --dry-run
