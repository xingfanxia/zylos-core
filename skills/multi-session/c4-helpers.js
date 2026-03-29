/**
 * Helpers for building C4 command arguments with multi-session instance routing.
 */

/**
 * If instanceId is truthy, push '--target-instance' and the id onto args.
 * Mutates and returns the original array for chaining convenience.
 * @param {string[]} args - argument array to append to
 * @param {string | null | undefined} instanceId
 * @returns {string[]} the same args array
 */
export function appendInstanceArgs(args, instanceId) {
  if (instanceId) {
    args.push('--target-instance', instanceId);
  }
  return args;
}

/**
 * Return a new argument array with instance routing appended (no mutation).
 * @param {string[]} baseArgs - base argument array
 * @param {string | null | undefined} instanceId
 * @returns {string[]} new array
 */
export function buildC4ControlArgs(baseArgs, instanceId) {
  const result = [...baseArgs];
  if (instanceId) {
    result.push('--target-instance', instanceId);
  }
  return result;
}
