// Naming a file well enough that PPSSPP will open it.
//
// PPSSPP picks its loader from the extension, and a host that fetched a game over the
// network has a `Blob` with no name at all. Guessing `.iso` for everything would boot
// a CSO into the wrong loader, so the contents decide.

import test from 'node:test';
import assert from 'node:assert/strict';

import { detectExtension, stage } from '../dist/ppsspp-wasm.js';

const withMagic = (text, at = 0, size = 64) => {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  return bytes;
};

test('each format is recognised by its own magic', () => {
  assert.equal(detectExtension(withMagic('\x7fELF')), '.elf');
  assert.equal(detectExtension(withMagic('CISO')), '.cso');
  assert.equal(detectExtension(withMagic('MComprHD')), '.chd');
  assert.equal(detectExtension(withMagic('PK\x03\x04')), '.zip');
  // A PBP starts with a zero byte, then the tag.
  assert.equal(detectExtension(withMagic('\0PBP')), '.pbp');
});

test('an ISO is recognised by its volume descriptor, one sector in', () => {
  assert.equal(detectExtension(withMagic('CD001', 0x8001, 0x8010)), '.iso');
});

test('anything unrecognised falls back to the format with no magic at all', () => {
  assert.equal(detectExtension(new Uint8Array(64)), '.iso');
});

test('a short file is not a crash', () => {
  assert.equal(detectExtension(new Uint8Array(2)), '.iso');
  assert.equal(detectExtension(new Uint8Array(0)), '.iso');
});

test("a File's own name wins — the host knows what the user expects to see", async () => {
  // Contents say CSO, the name says otherwise. The name is what the user picked.
  const file = new File([withMagic('CISO')], 'Daxter.iso');
  assert.deepEqual((await stage(file, 'game')).name, 'Daxter.iso');
});

test('an anonymous Blob is sniffed instead', async () => {
  const blob = new Blob([withMagic('CISO')]);
  const staged = await stage(blob, 'game');
  assert.equal(staged.name, 'game.cso');
  assert.equal(staged.blob, blob, 'and it stays a Blob — never read into memory');
  assert.equal(staged.bytes, undefined);
});

test('bytes stay bytes, and are named from what they contain', async () => {
  const bytes = withMagic('\x7fELF');
  const staged = await stage(bytes, 'game');
  assert.equal(staged.name, 'game.elf');
  assert.equal(staged.bytes, bytes);
  assert.equal(staged.blob, undefined);
});
