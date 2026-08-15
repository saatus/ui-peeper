/**
 * Capture jobs: created immediately, filled in as breakpoints finish.
 *
 * Screenshots land on disk rather than in memory — three full-page PNGs of a long
 * marketing site run to tens of megabytes, and holding every recent job in the
 * heap is how a 2GB box falls over. State is a plain Map because a POC that
 * forgets its jobs on restart is fine; nothing here is worth a database.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LIMITS } from './config.js';
import { captureBreakpoint } from './browser.js';
import { createZip } from './zip.js';

const ROOT = join(tmpdir(), 'ui-peeper');
const jobs = new Map();

/** Filename-safe hostname, e.g. `https://a.example.com/x` -> `a-example-com`. */
function slugHost(url) {
  try {
    return new URL(url).hostname.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'page';
  } catch {
    return 'page';
  }
}

/** What the client is allowed to see: no filesystem paths. */
function publicShot(shot) {
  const { file, ...rest } = shot;
  return rest;
}

export function publicJob(job) {
  return {
    id: job.id,
    url: job.url,
    status: job.status,
    createdAt: job.createdAt,
    shots: job.shots.map(publicShot),
  };
}

export function getJob(id) {
  return jobs.get(id) ?? null;
}

/**
 * Registers a job and starts rendering. Returns straight away so the client can
 * poll and show panes filling in one by one instead of staring at a spinner.
 */
export function startJob({ url, breakpoints }) {
  const id = randomUUID();
  const host = slugHost(url);

  const job = {
    id,
    url,
    status: 'running',
    createdAt: Date.now(),
    finishedAt: null,
    dir: join(ROOT, id),
    shots: breakpoints.map((bp) => ({
      id: bp.id,
      label: bp.label,
      width: bp.width,
      status: 'pending',
      filename: `${host}-${bp.width}w.png`,
      file: null,
      bytes: null,
      height: null,
      truncated: false,
      finalUrl: null,
      title: null,
      error: null,
    })),
  };

  jobs.set(id, job);
  runJob(job, host).catch((err) => {
    job.status = 'error';
    job.error = err?.message ?? 'Capture failed.';
    job.finishedAt = Date.now();
  });

  return job;
}

async function runJob(job, host) {
  await mkdir(job.dir, { recursive: true });

  // All breakpoints are kicked off together; the semaphore in browser.js decides
  // how many actually render at once.
  await Promise.all(
    job.shots.map(async (shot) => {
      shot.status = 'running';
      try {
        const result = await captureBreakpoint({ url: job.url, width: shot.width });
        const file = join(job.dir, `${host}-${shot.width}w.png`);
        await writeFile(file, result.buffer);

        shot.file = file;
        shot.bytes = result.buffer.length;
        shot.height = result.height;
        shot.truncated = result.truncated;
        shot.finalUrl = result.finalUrl;
        shot.title = result.title;
        shot.status = 'done';
      } catch (err) {
        shot.status = 'error';
        // One breakpoint failing should not lose the other two.
        shot.error = trimError(err);
      }
    }),
  );

  const anyDone = job.shots.some((s) => s.status === 'done');
  job.status = anyDone ? 'done' : 'error';
  job.finishedAt = Date.now();
}

/** Playwright errors carry a full call log; the pane header needs one line. */
function trimError(err) {
  const raw = err?.message ?? String(err);
  const first = raw.split('\n')[0].trim();
  if (/timeout/i.test(first)) return 'The site took too long to render.';
  if (/net::ERR_NAME_NOT_RESOLVED/.test(raw)) return 'That host could not be resolved.';
  if (/net::ERR_CONNECTION_REFUSED/.test(raw)) return 'The site refused the connection.';
  if (/net::ERR_CERT/.test(raw)) return 'The site has an invalid TLS certificate.';
  if (/blockedbyclient/i.test(raw)) return 'The site redirected to a blocked address.';
  return first.slice(0, 200) || 'Capture failed.';
}

export async function readShot(job, shotId) {
  const shot = job.shots.find((s) => s.id === shotId);
  if (!shot || shot.status !== 'done' || !shot.file) return null;
  return { shot, data: await readFile(shot.file) };
}

/** Zips every breakpoint that rendered. Returns null if none did. */
export async function buildArchive(job) {
  const done = job.shots.filter((s) => s.status === 'done' && s.file);
  if (done.length === 0) return null;

  const entries = await Promise.all(
    done.map(async (shot) => ({ name: shot.filename, data: await readFile(shot.file) })),
  );
  return createZip(entries, new Date(job.createdAt));
}

/* ------------------------------------------------------------------- sweeper */

/**
 * Screenshots of other people's sites are not ours to keep. Anything past its TTL
 * goes, files and record together.
 */
async function sweep() {
  const cutoff = Date.now() - LIMITS.jobTtlMs;
  for (const [id, job] of jobs) {
    const finished = job.finishedAt ?? job.createdAt;
    if (finished > cutoff) continue;
    jobs.delete(id);
    await rm(job.dir, { recursive: true, force: true }).catch(() => {});
  }
}

let sweeper = null;

export function startSweeper() {
  sweeper ??= setInterval(() => {
    sweep().catch(() => {});
  }, 60_000).unref();
}

export async function stopSweeper() {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}

/** Wipes any leftovers from a previous run of the process. */
export async function resetStorage() {
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
  await mkdir(ROOT, { recursive: true }).catch(() => {});
}
