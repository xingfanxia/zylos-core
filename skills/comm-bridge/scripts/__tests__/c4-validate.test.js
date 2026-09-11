/**
 * c4-validate — validateEndpoint / validateChannel hardening.
 *
 * validateEndpoint feeds the reply-via suffix (`c4-send.js "<ch>" "<endpoint>"`)
 * that is delivered to the agent as runnable text, so it must reject anything
 * that breaks out of the double-quoted context or corrupts reply-via parsing,
 * while accepting every real cross-channel endpoint shape.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateEndpoint } from '../c4-validate.js';

describe('validateEndpoint — accepts real endpoints', () => {
  const legit = [
    'oc_3c9f|type:p2p|msg:om_x123',
    'oc_3c9f|type:group|root:om_r|parent:om_p|msg:om_m',
    '123456789|msg:3|req:98765:3',      // telegram
    'system|approval',
    'default',                           // shell
    'user@example.com',                  // defensive: @ and . allowed
    'sess-1a2b3c-DEAD_beef.42',
  ];
  for (const ep of legit) {
    it(`accepts ${ep}`, () => {
      assert.equal(validateEndpoint(ep), ep);
    });
  }
});

describe('validateEndpoint — rejects malformed / dangerous endpoints', () => {
  it('rejects empty / non-string', () => {
    assert.throws(() => validateEndpoint(''), /non-empty string/);
    assert.throws(() => validateEndpoint(null), /non-empty string/);
    assert.throws(() => validateEndpoint(42), /non-empty string/);
  });

  it('rejects control characters (newline / CR / tab / NUL)', () => {
    assert.throws(() => validateEndpoint('oc_a|type:p2p\nmsg:om_x'), /control characters/);
    assert.throws(() => validateEndpoint('oc_a\r'), /control characters/);
    assert.throws(() => validateEndpoint('oc_a\tmsg'), /control characters/);
    assert.throws(() => validateEndpoint('oc_a\0'), /control characters/);
  });

  it('rejects shell metacharacters that break the reply-via quoting', () => {
    assert.throws(() => validateEndpoint('oc_a" ; rm -rf ~ ; "'), /shell metacharacters/);
    assert.throws(() => validateEndpoint('oc_a`whoami`'), /shell metacharacters/);
    assert.throws(() => validateEndpoint('oc_a$(id)'), /shell metacharacters/);
    assert.throws(() => validateEndpoint('oc_a\\'), /shell metacharacters/);
  });

  it('rejects an over-length endpoint', () => {
    assert.throws(() => validateEndpoint('a'.repeat(1025)), /maximum length/);
    assert.equal(validateEndpoint('a'.repeat(1024)).length, 1024);
  });
});
