/**
 * ZY-GRP-1 group-instance segmentation — REAL module imports (no replica logic).
 *
 * Covers the two pure building blocks that split the group instance's injected
 * session history by chat:
 *  - groupKeyFromEndpoint (skills/multi-session/c4-helpers.js)
 *  - groupConversationsByGroup (skills/comm-bridge/scripts/c4-db-multi.js)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { groupKeyFromEndpoint } from '../../../multi-session/c4-helpers.js';
import { groupConversationsByGroup } from '../c4-db-multi.js';

describe('groupKeyFromEndpoint', () => {
  it('returns the segment before the first pipe (feishu group endpoint)', () => {
    assert.equal(
      groupKeyFromEndpoint('oc_f37|type:group|root:om_1|parent:om_1|msg:om_2'),
      'oc_f37',
    );
  });

  it('returns the whole id when there is no pipe (bare chat id)', () => {
    assert.equal(groupKeyFromEndpoint('-1001234567'), '-1001234567');
  });

  it('trims surrounding whitespace', () => {
    assert.equal(groupKeyFromEndpoint('  oc_X | type:group'), 'oc_X');
  });

  it('returns null for null / undefined / empty / whitespace endpoints', () => {
    assert.equal(groupKeyFromEndpoint(null), null);
    assert.equal(groupKeyFromEndpoint(undefined), null);
    assert.equal(groupKeyFromEndpoint(''), null);
    assert.equal(groupKeyFromEndpoint('   '), null);
    assert.equal(groupKeyFromEndpoint('|only-pipe'), null);
  });
});

describe('groupConversationsByGroup', () => {
  const rows = [
    { id: 1, endpoint_id: 'oc_A|type:group|msg:1' },
    { id: 2, endpoint_id: 'oc_B|type:group|msg:1' },
    { id: 3, endpoint_id: null, channel: 'system' },
    { id: 4, endpoint_id: 'oc_A|type:group|msg:2' },
    { id: 5, endpoint_id: 'oc_B|type:group|msg:2' },
    { id: 6, endpoint_id: 'oc_B|type:group|msg:3' },
  ];

  it('segments rows into one bucket per group key', () => {
    const { buckets, totalGroups, omittedGroups } = groupConversationsByGroup(rows);
    assert.equal(totalGroups, 3); // oc_A, oc_B, and the null/system bucket
    assert.equal(omittedGroups, 0);
    assert.deepEqual(buckets.map((b) => b.key), ['oc_B', 'oc_A', null]);
  });

  it('orders groups most-recently-active first and sinks the system bucket last', () => {
    const { buckets } = groupConversationsByGroup(rows);
    // oc_B lastId=6 > oc_A lastId=4; null (system) always last regardless of id.
    assert.equal(buckets[0].key, 'oc_B');
    assert.equal(buckets[0].lastId, 6);
    assert.equal(buckets[1].key, 'oc_A');
    assert.equal(buckets[2].key, null);
    assert.equal(buckets[2].label, '(system / ungrouped)');
  });

  it('keeps conversations id-ascending within a bucket', () => {
    const { buckets } = groupConversationsByGroup(rows);
    const b = buckets.find((x) => x.key === 'oc_B');
    assert.deepEqual(b.conversations.map((c) => c.id), [2, 5, 6]);
  });

  it('caps each group to the most recent perGroupLimit rows but reports full count', () => {
    const { buckets } = groupConversationsByGroup(rows, { perGroupLimit: 2 });
    const b = buckets.find((x) => x.key === 'oc_B');
    assert.equal(b.count, 3); // full count preserved for the header
    assert.deepEqual(b.conversations.map((c) => c.id), [5, 6]); // most recent 2
  });

  it('limits the number of buckets to maxGroups and counts the remainder', () => {
    const { buckets, omittedGroups } = groupConversationsByGroup(rows, { maxGroups: 1 });
    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].key, 'oc_B'); // most-recently-active kept
    assert.equal(omittedGroups, 2);
  });

  it('handles empty / nullish input without throwing', () => {
    assert.deepEqual(groupConversationsByGroup([]), { buckets: [], omittedGroups: 0, totalGroups: 0 });
    assert.deepEqual(groupConversationsByGroup(undefined), { buckets: [], omittedGroups: 0, totalGroups: 0 });
  });
});
