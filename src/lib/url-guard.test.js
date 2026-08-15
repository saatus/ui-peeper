import test from 'node:test';
import assert from 'node:assert/strict';

import { isPublicAddress, normalizeUrl, UrlRejected, bareHostname } from './url-guard.js';

test('public addresses are allowed', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111']) {
    assert.equal(isPublicAddress(ip), true, `${ip} should be public`);
  }
});

test('private and reserved IPv4 ranges are blocked', () => {
  const blocked = [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1', // CGNAT
    '127.0.0.1',
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
  ];
  for (const ip of blocked) {
    assert.equal(isPublicAddress(ip), false, `${ip} should be blocked`);
  }
});

test('172.32.x is public — the /12 boundary is not a /8', () => {
  assert.equal(isPublicAddress('172.15.255.255'), true);
  assert.equal(isPublicAddress('172.32.0.1'), true);
});

test('private and reserved IPv6 ranges are blocked', () => {
  const blocked = ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1'];
  for (const ip of blocked) {
    assert.equal(isPublicAddress(ip), false, `${ip} should be blocked`);
  }
});

test('IPv6 forms that wrap a private IPv4 are unwrapped and blocked', () => {
  assert.equal(isPublicAddress('::ffff:127.0.0.1'), false, 'IPv4-mapped loopback');
  assert.equal(isPublicAddress('::ffff:7f00:1'), false, 'same, written as hextets');
  assert.equal(isPublicAddress('::ffff:169.254.169.254'), false, 'IPv4-mapped metadata');
  assert.equal(isPublicAddress('64:ff9b::10.0.0.1'), false, 'NAT64 private');
  assert.equal(isPublicAddress('2002:a00:1::'), false, '6to4 wrapping 10.0.0.1');

  assert.equal(isPublicAddress('::ffff:8.8.8.8'), true, 'IPv4-mapped public stays public');
});

test('garbage never counts as public', () => {
  for (const junk of ['', 'not-an-ip', '1.2.3', '1.2.3.4.5', '999.1.1.1', '01.02.03.04', 'g::1']) {
    assert.equal(isPublicAddress(junk), false, `${junk} should not be public`);
  }
});

test('normalizeUrl fills in a missing scheme', () => {
  assert.equal(normalizeUrl('example.com').href, 'https://example.com/');
  assert.equal(normalizeUrl('example.com/a/b?c=1').href, 'https://example.com/a/b?c=1');
  assert.equal(normalizeUrl('  example.com  ').href, 'https://example.com/');
  assert.equal(normalizeUrl('http://example.com').protocol, 'http:');
});

const rejects = (input, code) => {
  assert.throws(() => normalizeUrl(input), (err) => {
    assert.ok(err instanceof UrlRejected, `expected UrlRejected for ${input}`);
    assert.equal(err.code, code);
    return true;
  });
};

test('non-http schemes are rejected rather than silently prefixed', () => {
  rejects('javascript:alert(1)', 'bad_protocol');
  rejects('file:///etc/passwd', 'bad_protocol');
  rejects('data:text/html,<h1>x', 'bad_protocol');
  rejects('ftp://example.com', 'bad_protocol');
});

test('malformed and hostile inputs are rejected', () => {
  rejects('', 'missing_url');
  rejects('   ', 'missing_url');
  rejects(null, 'missing_url');
  rejects('https://user:pass@example.com', 'has_credentials');
  rejects(`https://example.com/${'a'.repeat(2100)}`, 'too_long');
});

test('bareHostname strips IPv6 brackets', () => {
  assert.equal(bareHostname(new URL('http://[::1]/')), '::1');
  assert.equal(bareHostname(new URL('http://example.com/')), 'example.com');
});
