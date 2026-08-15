/**
 * Decides whether a page can be shown in a live <iframe>.
 *
 * Two headers control this, and both mean "no" far more often than people expect:
 *   X-Frame-Options: DENY | SAMEORIGIN
 *   Content-Security-Policy: frame-ancestors …
 *
 * We are always a different origin than the site being inspected, so SAMEORIGIN
 * is as fatal as DENY, and a frame-ancestors list that is not `*` is fatal too.
 * Getting this right up front is what lets the UI drop a pane straight to
 * screenshot mode instead of showing the user an empty white box.
 */

import { assertSafeUrl, UrlRejected, normalizeUrl } from './url-guard.js';
import { USER_AGENT } from './config.js';

const MAX_REDIRECTS = 5;
const PROBE_TIMEOUT_MS = 12_000;

/** Pull `frame-ancestors` out of a CSP header, if it is there at all. */
function frameAncestorsOf(csp) {
  if (!csp) return null;
  for (const directive of csp.split(';')) {
    const parts = directive.trim().split(/\s+/);
    if (parts[0]?.toLowerCase() === 'frame-ancestors') {
      return parts.slice(1).map((p) => p.toLowerCase());
    }
  }
  return null;
}

/**
 * Verdict from the two headers. Returns `{framable, reason}` where `reason` is
 * short enough to show in a pane header.
 */
export function judgeFraming({ xFrameOptions, csp }) {
  const xfo = xFrameOptions?.trim().toLowerCase().split(/[\s,]+/)[0];
  if (xfo === 'deny') {
    return { framable: false, reason: 'Site sends X-Frame-Options: DENY' };
  }
  if (xfo === 'sameorigin') {
    return { framable: false, reason: 'Site sends X-Frame-Options: SAMEORIGIN' };
  }
  if (xfo === 'allow-from') {
    // Deprecated and unsupported by every current browser, so it behaves as DENY.
    return { framable: false, reason: 'Site sends the obsolete X-Frame-Options: ALLOW-FROM' };
  }

  const ancestors = frameAncestorsOf(csp);
  if (ancestors) {
    if (ancestors.includes("'none'")) {
      return { framable: false, reason: "Site sends CSP frame-ancestors 'none'" };
    }
    if (!ancestors.includes('*')) {
      return { framable: false, reason: 'Site restricts CSP frame-ancestors to specific origins' };
    }
  }

  return { framable: true, reason: 'No framing restrictions found' };
}

/**
 * Fetch just far enough to read the headers. Redirects are followed by hand so
 * each hop goes back through the SSRF guard — `redirect: 'follow'` would let a
 * public URL bounce us into a private one without a second look.
 */
export async function probeFraming(input) {
  let current = normalizeUrl(input);
  const chain = [];

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    await assertSafeUrl(current);

    let response;
    try {
      response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' },
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new UrlRejected(
        timedOut ? 'The site took too long to respond.' : 'Could not reach that site.',
        timedOut ? 'probe_timeout' : 'probe_failed',
      );
    }

    // We only ever wanted the headers; drop the body rather than buffer it.
    response.body?.cancel().catch(() => {});

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      chain.push(current.href);
      let next;
      try {
        next = new URL(location, current);
      } catch {
        throw new UrlRejected('The site redirected somewhere unparseable.', 'bad_redirect');
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new UrlRejected('The site redirected to a non-http url.', 'bad_redirect');
      }
      current = next;
      continue;
    }

    const verdict = judgeFraming({
      xFrameOptions: response.headers.get('x-frame-options'),
      csp: response.headers.get('content-security-policy'),
    });

    return {
      requestedUrl: normalizeUrl(input).href,
      finalUrl: current.href,
      status: response.status,
      contentType: response.headers.get('content-type') ?? null,
      redirects: chain,
      ...verdict,
    };
  }

  throw new UrlRejected('That url redirected too many times.', 'too_many_redirects');
}
