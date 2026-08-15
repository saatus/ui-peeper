/**
 * Central knobs. Everything tunable lives here so the server, the browser pool
 * and the front end all agree on the same limits.
 */

const int = (name, fallback) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
};

/** The three defaults: iPhone-class, iPad portrait, standard laptop. */
export const DEFAULT_BREAKPOINTS = [
  { id: 'mobile', label: 'Mobile', width: 375 },
  { id: 'tablet', label: 'Tablet', width: 768 },
  { id: 'desktop', label: 'Desktop', width: 1440 },
];

export const LIMITS = {
  /** Guard rails on user-supplied breakpoint widths. */
  minWidth: 240,
  maxWidth: 3840,
  maxBreakpoints: 6,

  /** Viewport height used while rendering. Full-page capture ignores it. */
  viewportHeight: 900,

  /** How long a single page is allowed to take before we give up on it. */
  navigationTimeoutMs: int('UI_PEEPER_NAV_TIMEOUT_MS', 30_000),
  /** Quiet period after load/scroll, so late-arriving CSS and fonts settle. */
  settleMs: int('UI_PEEPER_SETTLE_MS', 600),

  /** Chromium struggles past this; taller pages are captured clipped. */
  maxFullPageHeight: int('UI_PEEPER_MAX_PAGE_HEIGHT', 20_000),

  /** Breakpoints rendered at the same time, across all in-flight jobs. */
  captureConcurrency: int('UI_PEEPER_CONCURRENCY', 3),

  /** Screenshots are deleted this long after the job finishes. */
  jobTtlMs: int('UI_PEEPER_JOB_TTL_MS', 15 * 60_000),

  /** Per-IP token bucket for the two endpoints that cost real work. */
  rateLimit: {
    capacity: int('UI_PEEPER_RATE_CAPACITY', 12),
    refillPerMinute: int('UI_PEEPER_RATE_REFILL', 12),
  },
};

/**
 * One user agent for every breakpoint, on purpose. Sending a mobile UA at 375px
 * would let a site serve different markup, and then the panes would differ for
 * two reasons at once. Holding the UA fixed means any difference you see is CSS.
 */
export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/131.0.0.0 Safari/537.36 UIPeeper/0.1 (+https://github.com/saatus/ui-peeper)';

export const PORT = int('PORT', 3000);

/**
 * Skips the DNS/IP egress guard. Only set this where outbound traffic is
 * already restricted at the network layer (a locked-down container, an egress
 * proxy). On a public box, leaving this on turns the service into an SSRF relay.
 */
export const TRUST_NETWORK = process.env.UI_PEEPER_TRUST_NETWORK === '1';
