import test from 'node:test';
import assert from 'node:assert/strict';

import { judgeFraming } from './framing.js';

test('a page with neither header is framable', () => {
  assert.equal(judgeFraming({}).framable, true);
  assert.equal(judgeFraming({ xFrameOptions: null, csp: null }).framable, true);
});

test('X-Frame-Options blocks framing in every spelling', () => {
  for (const value of ['DENY', 'deny', ' Deny ', 'SAMEORIGIN', 'sameorigin', 'ALLOW-FROM https://x']) {
    assert.equal(judgeFraming({ xFrameOptions: value }).framable, false, value);
  }
});

test('CSP frame-ancestors is honoured', () => {
  assert.equal(judgeFraming({ csp: "frame-ancestors 'none'" }).framable, false);
  assert.equal(judgeFraming({ csp: "frame-ancestors 'self'" }).framable, false);
  assert.equal(judgeFraming({ csp: 'frame-ancestors https://partner.example' }).framable, false);
  assert.equal(judgeFraming({ csp: 'frame-ancestors *' }).framable, true);
});

test('frame-ancestors is found among other directives', () => {
  const csp = "default-src 'self'; frame-ancestors 'none'; img-src *";
  assert.equal(judgeFraming({ csp }).framable, false);
});

test('a CSP without frame-ancestors does not block framing', () => {
  assert.equal(judgeFraming({ csp: "default-src 'self'; script-src 'unsafe-inline'" }).framable, true);
});

test('directive matching is case-insensitive and whitespace-tolerant', () => {
  assert.equal(judgeFraming({ csp: "  FRAME-ANCESTORS   'NONE'  " }).framable, false);
});

test('a reason is always supplied for the UI', () => {
  assert.match(judgeFraming({ xFrameOptions: 'DENY' }).reason, /DENY/);
  assert.ok(judgeFraming({}).reason.length > 0);
});
