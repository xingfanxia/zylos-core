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

/**
 * Extract the stable group/chat key from a conversation `endpoint_id`.
 *
 * The group instance serves MANY chats through one instance; the chat is
 * identified by the leading segment of endpoint_id (everything before the first
 * `|`). Feishu group endpoints look like
 * `oc_<chat>|type:group|root:...|parent:...|msg:...`; telegram/other channels
 * with a bare chat id (no `|`) return the whole id. Used to segment injected
 * session-init history and to key `memory/groups/<group_key>/`.
 *
 * @param {string | null | undefined} endpointId
 * @returns {string | null} the group key, or null for system/null endpoints
 */
export function groupKeyFromEndpoint(endpointId) {
  if (endpointId == null) return null;
  const key = String(endpointId).split('|', 1)[0].trim();
  return key.length > 0 ? key : null;
}
