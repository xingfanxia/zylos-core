import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeTimestampToIso,
  resolveLastActivity,
} from '../health-dashboard.js';

describe('health-dashboard timestamp helpers', () => {
  it('normalizes seconds, milliseconds, and ISO strings', () => {
    assert.equal(normalizeTimestampToIso(1775041759), '2026-04-01T11:09:19.000Z');
    assert.equal(normalizeTimestampToIso(1775039830100), '2026-04-01T10:37:10.100Z');
    assert.equal(normalizeTimestampToIso('2026-04-01T10:37:10.100Z'), '2026-04-01T10:37:10.100Z');
  });

  it('prefers agent-status activity fields over stale api-activity timestamps', () => {
    const resolved = resolveLastActivity({
      statusData: {
        last_activity: 1775041759,
      },
      apiData: {
        updated_at: 1775039830100,
      },
    });

    assert.equal(resolved, '2026-04-01T11:09:19.000Z');
  });
});
