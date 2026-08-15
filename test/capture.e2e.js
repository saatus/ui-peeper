/**
 * End-to-end check against a local fixture.
 *
 * Renders the fixture through the real HTTP API at three widths and asserts the
 * PNGs actually differ in the way the fixture's media queries say they should.
 * A screenshot tool that quietly captures every breakpoint at the same width
 * still returns three valid PNGs, so "it produced files" is not evidence.
 *
 * Needs UI_PEEPER_TRUST_NETWORK=1 because the fixture is served from localhost,
 * which the SSRF guard blocks by design. Run it with:
 *   npm run test:e2e
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.UI_PEEPER_BASE ?? 'http://localhost:3111';

/** Reads width and height out of a PNG's IHDR chunk. */
function pngSize(buffer) {
  assert.deepEqual(
    [...buffer.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'not a PNG',
  );
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function serveFixture() {
  const html = await readFile(join(here, 'fixture', 'index.html'));
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

const json = async (path, options) => {
  const res = await fetch(`${BASE}${path}`, options);
  const body = await res.json();
  assert.ok(res.ok, `${path} failed: ${JSON.stringify(body)}`);
  return body;
};

test('captures a page at three breakpoints', { timeout: 120_000 }, async (t) => {
  const { server, port } = await serveFixture();
  t.after(() => server.close());

  const url = `http://127.0.0.1:${port}/`;
  const widths = [375, 768, 1440];

  let job = await json('/api/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, breakpoints: widths.map((width) => ({ width })) }),
  });

  const deadline = Date.now() + 90_000;
  while (job.status === 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    job = await json(`/api/capture/${job.id}`);
  }

  assert.equal(job.status, 'done', `job ended as ${job.status}`);
  assert.equal(job.shots.length, 3);

  const images = new Map();
  for (const shot of job.shots) {
    assert.equal(shot.status, 'done', `${shot.width}px failed: ${shot.error}`);

    const res = await fetch(`${BASE}/api/capture/${job.id}/shot/${shot.id}`);
    assert.ok(res.ok, `shot ${shot.id} not served`);
    assert.equal(res.headers.get('content-type'), 'image/png');

    const buffer = Buffer.from(await res.arrayBuffer());
    const size = pngSize(buffer);

    // The whole product promise: the render really happened at that viewport.
    assert.equal(size.width, shot.width, `${shot.width}px shot is ${size.width}px wide`);

    // The fixture is 1400px of filler plus content, so a full-page capture has
    // to be much taller than the 900px viewport. This is what proves fullPage
    // is doing its job rather than grabbing the fold.
    assert.ok(size.height > 1500, `${shot.width}px shot is only ${size.height}px tall`);

    images.set(shot.width, buffer);
  }

  // Different media queries fired, so the bytes cannot be identical.
  assert.notDeepEqual(images.get(375), images.get(768), '375 and 768 rendered identically');
  assert.notDeepEqual(images.get(768), images.get(1440), '768 and 1440 rendered identically');
});

test('bundles every breakpoint into a valid zip', { timeout: 120_000 }, async (t) => {
  const { server, port } = await serveFixture();
  t.after(() => server.close());

  let job = await json('/api/capture', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `http://127.0.0.1:${port}/`, breakpoints: [{ width: 400 }, { width: 900 }] }),
  });

  const deadline = Date.now() + 90_000;
  while (job.status === 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    job = await json(`/api/capture/${job.id}`);
  }
  assert.equal(job.status, 'done');

  const res = await fetch(`${BASE}/api/capture/${job.id}/archive.zip`);
  assert.ok(res.ok);
  assert.equal(res.headers.get('content-type'), 'application/zip');

  const dir = mkdtempSync(join(tmpdir(), 'peeper-e2e-'));
  try {
    const file = join(dir, 'out.zip');
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    const listing = execFileSync('unzip', ['-l', file], { encoding: 'utf8' });
    assert.match(listing, /400w\.png/);
    assert.match(listing, /900w\.png/);
    execFileSync('unzip', ['-t', file], { stdio: 'pipe' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
