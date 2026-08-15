import { DEFAULT_BREAKPOINTS, LIMITS } from './config.js';

export class BadRequest extends Error {
  constructor(message, code = 'bad_request') {
    super(message);
    this.name = 'BadRequest';
    this.code = code;
  }
}

/**
 * Validates client-supplied breakpoints.
 *
 * Widths are deduplicated and become the shot id, which keeps screenshot URLs
 * stable and readable (`/shot/bp-375`) instead of index-based and fragile.
 */
export function parseBreakpoints(input) {
  if (input === undefined || input === null) return DEFAULT_BREAKPOINTS;

  if (!Array.isArray(input) || input.length === 0) {
    throw new BadRequest('Send at least one breakpoint.', 'no_breakpoints');
  }
  if (input.length > LIMITS.maxBreakpoints) {
    throw new BadRequest(`At most ${LIMITS.maxBreakpoints} breakpoints per capture.`, 'too_many');
  }

  const seen = new Set();
  return input.map((bp) => {
    const width = Math.round(Number(bp?.width));
    if (!Number.isFinite(width)) {
      throw new BadRequest('Every breakpoint needs a numeric width.', 'bad_width');
    }
    if (width < LIMITS.minWidth || width > LIMITS.maxWidth) {
      throw new BadRequest(
        `Widths must be between ${LIMITS.minWidth} and ${LIMITS.maxWidth}px.`,
        'bad_width',
      );
    }
    if (seen.has(width)) {
      throw new BadRequest(`Duplicate breakpoint width: ${width}px.`, 'duplicate_width');
    }
    seen.add(width);

    const rawLabel = typeof bp?.label === 'string' ? bp.label.trim() : '';
    return {
      id: `bp-${width}`,
      label: rawLabel ? rawLabel.slice(0, 32) : `${width}px`,
      width,
    };
  });
}
