import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Node canonicalizes module URLs but preserves the CLI's symlink spelling in
// argv. Compare identities so farm/operator aliases still execute their hook.
// Imports from stdin, --eval, tests or a missing launcher remain side-effect free.
export function isCliEntry(moduleUrl, argvPath = process.argv[1]) {
  if (!argvPath) return false;
  try {
    return fs.realpathSync(argvPath) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch { return false; }
}
