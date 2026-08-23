/**
 * Getting a file the host handed us into a place PPSSPP can open it.
 *
 * The interesting decision here is that a `Blob` never becomes a `Uint8Array`. A PSP
 * ISO runs to 1.8 GB, the wasm heap is capped at 4 GB, and reading one into memory to
 * write it into MEMFS costs that size twice over — once in the JS heap for the array,
 * once in the wasm heap for the copy — before the emulator has allocated anything.
 * Emscripten's WORKERFS mounts a `Blob` and reads through to it lazily, so the same
 * ISO costs nothing. That is why {@link PpssppAssets.game} takes `Blob | Uint8Array`
 * and why the `Blob` half is the one a host should reach for.
 */

/** A staged file: a name PPSSPP can infer a format from, and its contents. */
export interface StagedAsset {
  readonly name: string;
  /** Mounted through WORKERFS, never copied. */
  readonly blob?: Blob;
  /** Written into MEMFS, and it costs its own size in the heap. */
  readonly bytes?: Uint8Array;
}

/** Enough of the head to reach the ISO9660 descriptor at 0x8001. */
const HEAD_BYTES = 0x8010;

function magic(head: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    // `noUncheckedIndexedAccess` makes this `number | undefined`, which is exactly
    // right: past the end of a short file the comparison simply fails.
    if (head[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * What kind of file this is, from its contents rather than its name.
 *
 * PPSSPP picks a loader by extension, so a `Blob` with no name — which is what a
 * host gets from `fetch()` — would otherwise have to be guessed at. Sniffing is both
 * more reliable than guessing and more reliable than a `File.name` that the user
 * renamed: a `.cso` called `game.iso` opens correctly this way.
 *
 * Falls back to `.iso`, which is the format that has no magic number at offset 0.
 */
export function detectExtension(head: Uint8Array): string {
  if (magic(head, 0, '\x7fELF')) return '.elf';
  if (magic(head, 0, 'CISO')) return '.cso';
  if (magic(head, 0, 'MComprHD')) return '.chd';
  if (head[0] === 0x00 && magic(head, 1, 'PBP')) return '.pbp';
  if (magic(head, 0, 'PK\x03\x04')) return '.zip';
  // ISO9660 puts `CD001` in the primary volume descriptor, one sector in.
  if (magic(head, 0x8001, 'CD001')) return '.iso';
  return '.iso';
}

/** A `File` without needing `File` to exist — Node has it, but not every runtime does. */
function namedFile(value: Blob): string | undefined {
  const name = (value as File).name;
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/**
 * Give a payload value a name and decide how it will be mounted.
 *
 * A `File`'s own name wins, because a host that picked it from disk knows something
 * we do not: the extension the user expects to see in PPSSPP's own game list.
 * Everything else is sniffed.
 */
export async function stage(value: Blob | Uint8Array, base: string): Promise<StagedAsset> {
  if (value instanceof Uint8Array) {
    return { name: base + detectExtension(value.subarray(0, HEAD_BYTES)), bytes: value };
  }
  const named = namedFile(value);
  if (named) return { name: named, blob: value };
  const head = new Uint8Array(await value.slice(0, HEAD_BYTES).arrayBuffer());
  return { name: base + detectExtension(head), blob: value };
}
