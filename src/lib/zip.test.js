import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createZip, crc32 } from './zip.js';

test('crc32 matches the standard check vector', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(crc32(Buffer.alloc(0)), 0);
});

test('the archive carries the expected signatures and entry count', () => {
  const zip = createZip([
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'b.txt', data: Buffer.from('world') },
  ]);

  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'starts with a local file header');
  const eocdAt = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocdAt), 0x06054b50, 'ends with the EOCD record');
  assert.equal(zip.readUInt16LE(eocdAt + 10), 2, 'records two entries');
});

test('an empty archive is still a valid zip', () => {
  const zip = createZip([]);
  assert.equal(zip.length, 22);
  assert.equal(zip.readUInt32LE(0), 0x06054b50);
});

// The real proof: a third-party implementation has to accept and round-trip it.
test('unzip verifies and extracts the archive', (t) => {
  let hasUnzip = true;
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
  } catch {
    hasUnzip = false;
  }
  if (!hasUnzip) return t.skip('unzip not installed');

  const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
  try {
    // Binary bytes plus a non-ASCII name: screenshots are binary, and entry
    // names are built from arbitrary hostnames.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f]);
    const archive = join(dir, 'out.zip');
    writeFileSync(
      archive,
      createZip([
        { name: 'shot-375.png', data: png },
        { name: 'notes-café.txt', data: Buffer.from('résumé', 'utf8') },
      ]),
    );

    // Validates every CRC and the central directory, including the entry with
    // the non-ASCII name.
    execFileSync('unzip', ['-t', archive], { stdio: 'pipe' });

    // Only the ASCII entry is round-tripped through the filesystem. The name a
    // non-ASCII entry lands under depends on how the local unzip was built:
    // with UNICODE_SUPPORT it converts UTF-8 to the current charset and escapes
    // what will not fit (notes-caf#U00e9.txt), without it the raw bytes are
    // written through. That is a property of the extractor, not of this writer,
    // so the UTF-8 encoding is asserted against the archive bytes instead.
    execFileSync('unzip', ['-o', '-q', archive, 'shot-375.png', '-d', dir], { stdio: 'pipe' });
    assert.deepEqual(readFileSync(join(dir, 'shot-375.png')), png, 'binary survives intact');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('non-ASCII entry names are stored as UTF-8 with the flag set', () => {
  const name = 'notes-café.txt';
  const encoded = Buffer.from(name, 'utf8');
  const data = Buffer.from('résumé', 'utf8');
  const zip = createZip([{ name, data }]);

  assert.ok(zip.includes(encoded), 'the UTF-8 encoded name appears in the archive');

  // General purpose bit 11 (0x0800) is what tells a reader the name is UTF-8
  // rather than the legacy CP437. Without it, readers guess, and non-ASCII
  // names come out wrong.
  const FLAG_UTF8 = 0x0800;
  assert.equal(zip.readUInt16LE(6) & FLAG_UTF8, FLAG_UTF8, 'flag set in local header');

  const centralAt = 30 + encoded.length + data.length;
  assert.equal(zip.readUInt32LE(centralAt), 0x02014b50, 'central directory follows the entry');
  assert.equal(
    zip.readUInt16LE(centralAt + 8) & FLAG_UTF8,
    FLAG_UTF8,
    'flag set in central directory too',
  );
});
