/**
 * The Chromium side: one shared browser, one context per breakpoint.
 *
 * A context per breakpoint (rather than resizing one page) keeps the runs
 * genuinely independent — separate cookie jar, separate cache — so a site that
 * remembers "you already dismissed the banner" cannot make the 1440px shot look
 * different from the 375px one for reasons that have nothing to do with CSS.
 */

import { chromium } from 'playwright';

import { LIMITS, USER_AGENT, TRUST_NETWORK } from './config.js';
import { assertSafeUrl } from './url-guard.js';

let browserPromise = null;

export async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        // Set this when the bundled Chromium build does not match the installed
        // Playwright version, or when running against a system Chromium.
        executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
        args: [
          // /dev/shm is tiny in most containers and Chromium will crash without this.
          '--disable-dev-shm-usage',
          '--hide-scrollbars',
          '--mute-audio',
          // Deliberately NOT --no-sandbox. This process renders hostile HTML for a
          // living, so the sandbox is the one thing that should never be traded away;
          // the Dockerfile runs as a non-root user precisely so it keeps working.
        ],
      })
      .catch((err) => {
        browserPromise = null; // let the next request try again
        throw err;
      });
  }
  return browserPromise;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise.catch(() => null);
  browserPromise = null;
  await browser?.close().catch(() => {});
}

/* --------------------------------------------------------------- concurrency */

/** Chromium contexts are memory-hungry; this caps how many render at once. */
function createSemaphore(max) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };
  return async function acquire() {
    if (active >= max) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
    return release;
  };
}

const acquireSlot = createSemaphore(LIMITS.captureConcurrency);

/* ------------------------------------------------------------------ helpers */

/**
 * Compresses animation and transition durations to ~zero.
 *
 * Without it, any site with a fade-in or a carousel screenshots mid-motion and
 * the same URL gives a different PNG every run. Injected at document start so it
 * beats the page's own stylesheets.
 */
const STABILISE = `*, *::before, *::after {
  animation-duration: 1ms !important;
  animation-delay: 0s !important;
  animation-iteration-count: 1 !important;
  transition-duration: 1ms !important;
  transition-delay: 0s !important;
  scroll-behavior: auto !important;
  caret-color: transparent !important;
}`;

/**
 * Walks the page to the bottom and back to the top.
 *
 * Lazy-loaded images only fetch when they scroll into view, and scroll-triggered
 * reveals only fire once seen. Skipping this gives a full-page screenshot that is
 * mostly blank placeholders below the fold.
 */
async function autoScroll(page, maxHeight) {
  await page
    .evaluate(async (cap) => {
      await new Promise((resolve) => {
        const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
        let travelled = 0;
        const stopAt = Date.now() + 10_000; // never let a scroll-jacking site trap us

        const timer = setInterval(() => {
          const doc = document.documentElement;
          window.scrollBy(0, step);
          travelled += step;

          const atBottom = window.innerHeight + window.scrollY >= doc.scrollHeight - 2;
          if (atBottom || travelled >= cap || Date.now() > stopAt) {
            clearInterval(timer);
            resolve();
          }
        }, 100);
      });
    }, maxHeight)
    .catch(() => {}); // a page that navigates mid-scroll is not worth failing over

  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

/**
 * Re-checks document navigations against the SSRF guard.
 *
 * The initial URL was already cleared, but a page can redirect or meta-refresh
 * itself somewhere internal after that. Sub-resources are passed straight through
 * so we are not resolving DNS for every image on the page.
 */
async function guardNavigations(context) {
  if (TRUST_NETWORK) return;
  await context.route('**/*', async (route, request) => {
    if (request.resourceType() !== 'document') return route.continue();
    try {
      await assertSafeUrl(request.url());
      return route.continue();
    } catch {
      return route.abort('blockedbyclient');
    }
  });
}

/* ------------------------------------------------------------------ capture */

/**
 * Render one breakpoint and return a full-page PNG.
 * @returns {Promise<{buffer: Buffer, width: number, height: number, truncated: boolean, finalUrl: string, title: string}>}
 */
export async function captureBreakpoint({ url, width }) {
  const release = await acquireSlot();
  const browser = await getBrowser();

  const context = await browser.newContext({
    viewport: { width, height: LIMITS.viewportHeight },
    deviceScaleFactor: 1,
    userAgent: USER_AGENT,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
    // Screenshots of someone else's site should never carry our cookies anyway,
    // but a fresh context each time makes that explicit.
    javaScriptEnabled: true,
  });

  try {
    await guardNavigations(context);
    await context.addInitScript((css) => {
      const inject = () => {
        const style = document.createElement('style');
        style.setAttribute('data-ui-peeper', '');
        style.textContent = css;
        document.documentElement.appendChild(style);
      };
      if (document.documentElement) inject();
      else document.addEventListener('DOMContentLoaded', inject, { once: true });
    }, STABILISE);

    const page = await context.newPage();
    page.setDefaultTimeout(LIMITS.navigationTimeoutMs);

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: LIMITS.navigationTimeoutMs,
    });

    // `load` and `networkidle` are best-effort: plenty of healthy sites poll
    // forever and would never reach either, and a usable screenshot beats a
    // timeout error.
    await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
    await autoScroll(page, LIMITS.maxFullPageHeight);
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(LIMITS.settleMs);

    const height = await page.evaluate(() => {
      const doc = document.documentElement;
      const body = document.body;
      return Math.max(
        doc?.scrollHeight ?? 0,
        doc?.offsetHeight ?? 0,
        body?.scrollHeight ?? 0,
        body?.offsetHeight ?? 0,
        1,
      );
    });

    const truncated = height > LIMITS.maxFullPageHeight;
    const buffer = await page.screenshot({
      type: 'png',
      fullPage: !truncated,
      // Chromium fails outright past a certain surface size, so absurdly tall
      // pages are clipped and flagged rather than erroring the whole job.
      clip: truncated
        ? { x: 0, y: 0, width, height: LIMITS.maxFullPageHeight }
        : undefined,
    });

    return {
      buffer,
      width,
      height: truncated ? LIMITS.maxFullPageHeight : height,
      truncated,
      finalUrl: page.url(),
      title: await page.title().catch(() => ''),
    };
  } finally {
    await context.close().catch(() => {});
    release();
  }
}
