import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { DEFAULT_BREAKPOINTS, LIMITS, PORT, TRUST_NETWORK } from './lib/config.js';
import { UrlRejected, normalizeUrl, assertSafeUrl } from './lib/url-guard.js';
import { probeFraming } from './lib/framing.js';
import { parseBreakpoints, BadRequest } from './lib/breakpoints.js';
import {
  startJob,
  getJob,
  publicJob,
  readShot,
  buildArchive,
  startSweeper,
  resetStorage,
} from './lib/jobs.js';
import { closeBrowser } from './lib/browser.js';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();

// Behind nginx or a PaaS router, req.ip is the proxy without this.
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
app.disable('x-powered-by');

app.use(express.json({ limit: '16kb' }));

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // We frame other people's sites; nobody needs to frame us.
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      // The entire point of the live pane — any origin the user asks for.
      'frame-src *',
    ].join('; '),
  });
  next();
});

/* -------------------------------------------------------------- rate limiting */

function rateLimiter({ capacity, refillPerMinute }) {
  const buckets = new Map();
  const perMs = refillPerMinute / 60_000;

  // Buckets that have refilled completely carry no information; drop them so a
  // long-running process does not accumulate one entry per IP forever.
  setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) {
      if (b.tokens + (now - b.last) * perMs >= capacity) buckets.delete(key);
    }
  }, 300_000).unref();

  return (req, res, next) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const bucket = buckets.get(key) ?? { tokens: capacity, last: now };

    bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.last) * perMs);
    bucket.last = now;

    if (bucket.tokens < 1) {
      buckets.set(key, bucket);
      res.set('Retry-After', '30');
      return res.status(429).json({ error: 'Too many requests. Give it a minute.', code: 'rate_limited' });
    }

    bucket.tokens -= 1;
    buckets.set(key, bucket);
    next();
  };
}

const limit = rateLimiter(LIMITS.rateLimit);

/* -------------------------------------------------------------------- routes */

app.get('/api/config', (req, res) => {
  res.json({
    defaultBreakpoints: DEFAULT_BREAKPOINTS,
    limits: {
      minWidth: LIMITS.minWidth,
      maxWidth: LIMITS.maxWidth,
      maxBreakpoints: LIMITS.maxBreakpoints,
      jobTtlMinutes: Math.round(LIMITS.jobTtlMs / 60_000),
    },
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

/** Can this URL go in a live iframe? Drives the live-vs-screenshot decision. */
app.post('/api/probe', limit, async (req, res) => {
  res.json(await probeFraming(req.body?.url));
});

app.post('/api/capture', limit, async (req, res) => {
  const { url } = await assertSafeUrl(normalizeUrl(req.body?.url));
  const breakpoints = parseBreakpoints(req.body?.breakpoints);

  const job = startJob({ url: url.href, breakpoints });
  res.status(202).json(publicJob(job));
});

app.get('/api/capture/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'That capture has expired.', code: 'not_found' });
  res.json(publicJob(job));
});

app.get('/api/capture/:id/shot/:shotId', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'That capture has expired.', code: 'not_found' });

  const found = await readShot(job, req.params.shotId);
  if (!found) return res.status(404).json({ error: 'No screenshot for that breakpoint.', code: 'not_found' });

  const disposition = req.query.download === '1' ? 'attachment' : 'inline';
  res.set({
    'Content-Type': 'image/png',
    'Content-Disposition': `${disposition}; filename="${found.shot.filename}"`,
    'Cache-Control': 'private, max-age=600',
  });
  res.send(found.data);
});

app.get('/api/capture/:id/archive.zip', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'That capture has expired.', code: 'not_found' });

  const zip = await buildArchive(job);
  if (!zip) return res.status(409).json({ error: 'Nothing rendered successfully.', code: 'empty' });

  let host = 'capture';
  try {
    host = new URL(job.url).hostname.replace(/[^a-z0-9]+/gi, '-');
  } catch {
    /* keep the fallback */
  }

  res.set({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="ui-peeper-${host}.zip"`,
    'Content-Length': String(zip.length),
  });
  res.send(zip);
});

app.use(express.static(join(here, '..', 'public'), { extensions: ['html'] }));

/* --------------------------------------------------------------------- errors */

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof UrlRejected || err instanceof BadRequest) {
    return res.status(400).json({ error: err.message, code: err.code });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large.', code: 'too_large' });
  }

  console.error('[ui-peeper]', err);
  res.status(500).json({ error: 'Something went wrong rendering that.', code: 'internal' });
});

/* ------------------------------------------------------------------- lifecycle */

if (TRUST_NETWORK) {
  console.warn(
    '[ui-peeper] UI_PEEPER_TRUST_NETWORK=1 — the SSRF guard is OFF. Only safe if\n' +
      '            outbound traffic is already restricted at the network layer.',
  );
}

await resetStorage();
startSweeper();

const server = app.listen(PORT, () => {
  console.log(`[ui-peeper] listening on http://localhost:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(async () => {
      await closeBrowser();
      process.exit(0);
    });
  });
}

export { app };
