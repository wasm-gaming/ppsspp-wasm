/**
 * The one place where this package's host-facing vocabulary meets PPSSPP's own.
 *
 * A host says `textureFiltering: 'linear'`; `ppsspp.ini` says
 * `[Graphics] TextureFiltering = 3`. Both are right, and neither should leak into the
 * other — a settings screen must not have to know the integer, and PPSSPP must not be
 * asked to learn a new name. So the translation lives here, once, as data.
 *
 * Every section and key below is taken from PPSSPP's `Core/Config.cpp`, and every
 * integer from `Core/ConfigValues.h`. Where PPSSPP has no setting for something a
 * host reasonably wants — fast-forward is a runtime toggle, not an ini entry — the
 * binding uses a `Web/` key, which is this package's own namespace on the bridge and
 * is handled natively rather than written to the ini. See `native/README.md`.
 */
import type { PpssppConfig, PpssppOptions } from './payloads.js';

/** `Section/Key`, exactly as `ppsspp_web_apply_setting` takes it. */
export type SettingKey = string;

/**
 * How one host-facing property reaches PPSSPP.
 *
 * `live` here is the *claim* the descriptor in `spec.ts` makes, and the two are
 * checked against each other by a test — a property advertised as `live: true` that
 * has no binding to apply it with would be a lie a host acts on.
 */
export interface Binding<Value> {
  readonly key: SettingKey;
  readonly encode: (value: Value) => string;
}

const bool = (value: boolean): string => (value ? 'True' : 'False');
const int = (value: number): string => String(Math.trunc(value));

/** `Core/ConfigValues.h`: `enum TextureFiltering`. */
const TEXTURE_FILTERING = { auto: 1, nearest: 2, linear: 3 } as const;

/**
 * `Core/ConfigValues.h`: `enum class CPUCore`. `JIT = 1` and `JIT_IR = 3` are absent
 * on purpose — WebAssembly has no runtime code generation, so neither can exist in
 * this build, and offering them would be offering a crash.
 */
const CPU_CORE = { interpreter: 0, 'ir-interpreter': 2 } as const;

/**
 * `null` marks a property this package acts on itself rather than handing to PPSSPP:
 * `threads` sizes the Emscripten worker pool at instantiation, and `resume` decides
 * what `open()` does at boot. Neither is an emulator setting.
 */
export const CONFIG_BINDINGS: { [K in keyof PpssppConfig]: Binding<PpssppConfig[K]> | null } = {
  internalResolution: { key: 'Graphics/InternalResolution', encode: int },
  textureFiltering: { key: 'Graphics/TextureFiltering', encode: (v) => int(TEXTURE_FILTERING[v]) },
  frameSkip: { key: 'Graphics/FrameSkip', encode: int },
  autoFrameSkip: { key: 'Graphics/AutoFrameSkip', encode: bool },
  soundEnabled: { key: 'Sound/Enable', encode: bool },
  volume: { key: 'Sound/GameVolume', encode: int },
  language: { key: 'General/Language', encode: (v) => v },
  cpuCore: { key: 'CPU/CPUCore', encode: (v) => int(CPU_CORE[v]) },
  threads: null,
};

export const OPTION_BINDINGS: { [K in keyof PpssppOptions]: Binding<PpssppOptions[K]> | null } = {
  stateSlot: { key: 'General/StateSlot', encode: int },
  cheats: { key: 'General/EnableCheats', encode: bool },
  // Not an ini entry in PPSSPP — throttling is runtime state. The bridge takes it
  // under this package's own `Web/` namespace.
  fastForward: { key: 'Web/FastForward', encode: bool },
  // No binding of its own: `resume` and `stateSlot` collapse into a single PPSSPP
  // setting, which one-key-to-one-setting cannot express. See `autoLoadSaveState`.
  resume: null,
};

/**
 * `resume` and `stateSlot` reach PPSSPP as one number.
 *
 * `Core/Config.h`, on `iAutoLoadSaveState`: *0 = off, 1 = oldest (deprecated),
 * 2 = newest, 3+ = slot number + 3*. So resuming into slot 2 is `5`, and the encoding
 * is worth writing down once here rather than being rediscovered at the call site.
 */
export function autoLoadSaveState(options: { resume: boolean; stateSlot: number }): ResolvedSetting {
  return {
    section: 'General',
    key: 'AutoLoadSaveState',
    value: options.resume ? int(3 + options.stateSlot) : '0',
  };
}

/** One `Section/Key = Value` pair, ready to be grouped into an ini. */
export interface ResolvedSetting {
  readonly section: string;
  readonly key: string;
  readonly value: string;
}

/**
 * Resolve a payload against its bindings, dropping the properties that have none and
 * the ones the caller did not set.
 *
 * `Partial` rather than the whole payload, because this serves both jobs: the boot
 * ini wants every value, a `patched()` call wants only what changed.
 */
export function resolve<T extends object>(
  bindings: { [K in keyof T]: Binding<T[K]> | null },
  values: Partial<T>,
): ResolvedSetting[] {
  const out: ResolvedSetting[] = [];
  for (const name of Object.keys(values) as (keyof T)[]) {
    const binding = bindings[name];
    const value = values[name];
    if (!binding || value === undefined) continue;
    const slash = binding.key.indexOf('/');
    out.push({
      section: binding.key.slice(0, slash),
      key: binding.key.slice(slash + 1),
      value: binding.encode(value as T[keyof T]),
    });
  }
  return out;
}

/**
 * The `ppsspp.ini` PPSSPP reads at boot.
 *
 * Written rather than driven through the bridge because most of these are read once,
 * while the emulator is coming up — applying them afterwards would mean booting at
 * the wrong resolution and then changing it, which reallocates every render target.
 *
 * `Web/` keys are filtered out: they are this package's own, and PPSSPP would only
 * write them back out again as unknown entries.
 */
export function toIni(settings: readonly ResolvedSetting[]): string {
  const sections = new Map<string, string[]>();
  for (const setting of settings) {
    if (setting.section === 'Web') continue;
    let lines = sections.get(setting.section);
    if (!lines) sections.set(setting.section, (lines = []));
    lines.push(`${setting.key} = ${setting.value}`);
  }
  const out: string[] = [];
  for (const [section, lines] of sections) {
    out.push(`[${section}]`, ...lines, '');
  }
  return out.join('\n');
}
