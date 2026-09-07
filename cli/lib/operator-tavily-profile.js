import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');

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
  if (!match || match[2] !== hash(root) || match[1] !== hash(match[3])) throw new Error('Operator Tavily overlay does not match the managed Zylos scope');
  return ['-p', 'zylos-tavily'];
}
