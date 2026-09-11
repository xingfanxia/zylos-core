/**
 * ZY-UX-1 onboarding helpers — REAL module imports. Renders the actual
 * templates/messages/*.md files and covers language detection + the quota
 * breach comparator.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  detectLang,
  renderOnboardingMessage,
  checkQuotaBreaches,
} from '../onboarding-messages.js';

describe('detectLang', () => {
  it('returns zh for CJK text, en otherwise', () => {
    assert.equal(detectLang('你好，请帮我'), 'zh');
    assert.equal(detectLang('hello there'), 'en');
    assert.equal(detectLang(''), 'en');
    assert.equal(detectLang(null), 'en');
  });
});

describe('renderOnboardingMessage (real templates)', () => {
  it('renders the en welcome with a spaced name', () => {
    const out = renderOnboardingMessage('welcome', { lang: 'en', name: 'Alice' });
    assert.match(out, /Welcome Alice!/);
    assert.doesNotMatch(out, /\{name\}/);
    assert.doesNotMatch(out, /^## /m); // section header stripped
  });

  it('renders the zh hold-ack and omits the name gap when no name', () => {
    const out = renderOnboardingMessage('hold-ack', { lang: 'zh' });
    assert.match(out, /你好/);
    assert.match(out, /管理员/);
    assert.doesNotMatch(out, /\{name\}/);
    assert.doesNotMatch(out, /你好 ！/); // no dangling space before ！
  });

  it('falls back to en for an unknown lang', () => {
    const out = renderOnboardingMessage('welcome', { lang: 'fr', name: 'Bob' });
    assert.match(out, /Welcome Bob!/);
  });
});

describe('checkQuotaBreaches', () => {
  const cache = { instances: { 'user-a': { daily: 6_000_000 }, 'user-b': { daily: 1_000 }, 'user-c': { daily: 500 } } };
  const instances = {
    'user-a': { quota_tokens_daily: 5_000_000 }, // over
    'user-b': { quota_tokens_daily: 5_000_000 }, // under
    'user-c': {},                                // no quota → ignored
    'user-d': { quota_tokens_daily: 5_000_000 }, // no usage row → 0, under
  };
  it('returns only instances whose daily usage exceeds their quota', () => {
    const b = checkQuotaBreaches(cache, instances);
    assert.deepEqual(b, [{ instance: 'user-a', used: 6_000_000, quota: 5_000_000 }]);
  });
  it('is safe on empty / missing inputs', () => {
    assert.deepEqual(checkQuotaBreaches({}, {}), []);
    assert.deepEqual(checkQuotaBreaches(undefined, undefined), []);
  });
});
