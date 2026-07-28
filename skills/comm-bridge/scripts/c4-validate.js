import fs from 'fs';
import path from 'path';
import { SKILLS_DIR } from './c4-config.js';

export function validateChannel(channel, requirePath) {
  if (requirePath) {
    if (channel.includes('..') || channel.includes('/')) {
      throw new Error('Invalid channel name: path traversal detected');
    }

    const skillsDir = path.resolve(SKILLS_DIR);
    const resolved = path.resolve(skillsDir, channel);

    if (!resolved.startsWith(skillsDir + path.sep)) {
      throw new Error('Invalid channel name: resolved path escapes skills directory');
    }

    const stats = fs.statSync(resolved, { throwIfNoEntry: false });
    if (!stats || !stats.isDirectory()) {
      throw new Error(`Invalid channel name: directory not found (${channel})`);
    }
  }

  return channel;
}

// Endpoints are embedded verbatim into the reply-via suffix built by
// buildReplyViaSuffix() as:  ... c4-send.js "<channel>" "<endpoint>"
// That string is delivered to the agent as runnable text, so an endpoint
// containing a double-quote / backtick / $ / backslash could break out of the
// double-quoted context (shell injection when the agent runs it), and a control
// character (newline/CR) would split the suffix across lines and corrupt both
// reply-via parsing and the unanswered-message preview. Real endpoints across
// every channel are alphanumerics + | : _ - . @ (chat ids, message ids, type
// tags: e.g. `oc_..|type:p2p|msg:om_..`, `<num>|msg:3|req:<num>:3`), none of
// which are affected by these rejections.
const ENDPOINT_MAX_LENGTH = 1024;
const ENDPOINT_CONTROL_CHARS = /[\x00-\x1F\x7F]/;
const ENDPOINT_SHELL_METACHARS = /["`$\\]/;

export function validateEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'string') {
    throw new Error('Invalid endpoint: must be a non-empty string');
  }
  if (endpoint.length > ENDPOINT_MAX_LENGTH) {
    throw new Error(`Invalid endpoint: exceeds maximum length (${ENDPOINT_MAX_LENGTH})`);
  }
  if (ENDPOINT_CONTROL_CHARS.test(endpoint)) {
    throw new Error('Invalid endpoint: control characters not allowed');
  }
  if (ENDPOINT_SHELL_METACHARS.test(endpoint)) {
    throw new Error('Invalid endpoint: shell metacharacters (" ` $ \\) not allowed');
  }

  return endpoint;
}
