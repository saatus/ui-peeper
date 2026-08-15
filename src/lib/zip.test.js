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
    // Include binary bytes and a non-ASCII name, since screenshots are binary
    // and slugs come from arbitrary hostnames.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f]);
    const archive = join(dir, 'out.zip');
    writeFileSync(
      archive,
      createZip([
        { name: 'shot-375.png', data: png },
        { name: 'notes-café.txt', data: Buffer.from('résumé', 'utf8') },
      ]),
    );

    execFileSync('unzip', ['-t', archive], { stdio: 'pipe' });
    execFileSync('unzip', ['-o', '-q', archive, '-d', dir], { stdio: 'pipe' });

    assert.deepEqual(readFileSync(join(dir, 'shot-375.png')), png, 'binary survives intact');
    assert.equal(readFileSync(join(dir, 'notes-café.txt'), 'utf8'), 'résumé');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
