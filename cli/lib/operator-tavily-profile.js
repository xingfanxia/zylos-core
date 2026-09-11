import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse } from 'smol-toml';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');

// Native Codex appends model announcement counters to its active config.
// Keep the original managed bytes authenticated; exempt only that typed,
// trailing UI table, never MCP endpoints, commands, profiles or other settings.
function managedBodyMatches(body, expectedHash) {
  if (hash(body) === expectedHash) return true;
  const offset = body.search(/^\[tui\.model_availability_nux\]\r?$/m);
  if (offset < 0) return false;
  try {
    const suffix = parse(body.slice(offset));
    const counters = suffix.tui?.model_availability_nux;
    if (Object.keys(suffix).join() !== 'tui'
        || Object.keys(suffix.tui).join() !== 'model_availability_nux'
        || !counters || typeof counters !== 'object' || Array.isArray(counters)
        || !Object.entries(counters).every(([model, count]) => /^gpt-[A-Za-z0-9._-]+$/.test(model)
          && Number.isSafeInteger(count) && count >= 0 && count <= 0xffffffff)) return false;
    const prefix = body.slice(0, offset);
    return hash(prefix) === expectedHash
      || (prefix.endsWith('\n\n') && hash(prefix.slice(0, -1)) === expectedHash);
  } catch { return false; }
}

/** Activate only the operator's existing Zylos Tavily scope, never globally. */
export function operatorTavilyProfileArgs({ instanceId, osUser, runtimeHome, codexHome, instanceCwd, zylosDir, existingArgs = [] }) {
  if (osUser || !['admin', 'scheduler'].includes(instanceId)) return [];
  // Native CLI accepts one profile. Preserve an explicitly selected profile;
  // never silently replace it with this optional MCP-only layer.
  if (existingArgs.some(arg => arg === '-p' || arg === '--profile' || arg.startsWith('--profile=') || /^-p.+/.test(arg))) return [];
  let root; let cwd; let home;
  try {
    root = fs.realpathSync(zylosDir); cwd = fs.realpathSync(instanceCwd); home = fs.realpathSync(runtimeHome);
  } catch { return []; }
  if (cwd !== path.join(root, 'instances', instanceId) || fs.statSync(home).uid !== process.getuid()) return [];
  const profileRoot = fs.realpathSync(codexHome);
  const profileStat = fs.statSync(profileRoot);
  if (profileStat.uid !== process.getuid() || (profileStat.mode & 0o077)) return [];
  const file = path.join(profileRoot, 'zylos-tavily.config.toml');
  let stat; try { stat = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Operator Tavily overlay must be private and owned by the runtime UID');
  const text = fs.readFileSync(file, 'utf8');
  const match = text.match(/^# zylos-tavily-mcp-v1 ([a-f0-9]{64})\n# project-scope ([a-f0-9]{64})\n([\s\S]*)$/);
  if (!match || match[2] !== hash(root) || !managedBodyMatches(match[3], match[1])) throw new Error('Operator Tavily overlay does not match the managed Zylos scope');
  return ['-p', 'zylos-tavily'];
}
