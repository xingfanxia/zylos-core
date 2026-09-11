/**
 * Fork-specific constants.
 *
 * Centralises the fork/upstream repo identifiers so they are never
 * hardcoded inside self-upgrade.js (v1's biggest mistake).
 *
 * @module fork-config
 */

/** GitHub owner/repo for this fork. */
export const FORK_REPO = 'xingfanxia/zylos-core';

/** GitHub owner/repo for the canonical upstream. */
export const UPSTREAM_REPO = 'zylos-ai/zylos-core';

/** @returns {boolean} `true` when running from a fork (repos differ). */
export function isFork() {
  return FORK_REPO !== UPSTREAM_REPO;
}

/** @returns {boolean} `true` when an upstream-merge check is relevant. */
export function needsUpstreamCheck() {
  return isFork();
}
