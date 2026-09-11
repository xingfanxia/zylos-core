import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// These are installation state or dependency bulk, not component instructions.
// Runtime files remain at their original paths; the view never copies secrets
// or changes permissions on the installed component tree.
const EXCLUDED_DIRECTORIES = new Set([
  'node_modules', '.git', '.zylos', '.backup', '.backups', '.cache',
  '.venv', '__pycache__', 'coverage',
]);
const exists = file => { try { fs.lstatSync(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const inside = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);
const digest = data => crypto.createHash('sha256').update(data).digest('hex');

/** Index component sources and only exported skill trees of direct dependencies. */
export function collectCodexSkillFiles(skillsDir) {
  const sourceRoot = fs.realpathSync(skillsDir);
  const files = new Map();
  const entrypoints = new Set();
  const entrypointIdentities = {};
  const excluded = new Set();
  const sourcePath = file => {
    const real = fs.realpathSync(file);
    if (!inside(sourceRoot, real)) throw new Error(`Skill view refuses an outside-source link: ${path.relative(sourceRoot, file)}`);
    return real;
  };
  function walk(directory, relative = '', ancestors = new Set()) {
    const real = sourcePath(directory);
    if (ancestors.has(real)) throw new Error(`Skill directory cycle: ${relative}`);
    const visited = new Set([...ancestors, real]);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (EXCLUDED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.backup')) { excluded.add(rel); continue; }
      const file = path.join(directory, entry.name);
      const target = sourcePath(file);
      const stat = fs.statSync(target);
      if (stat.isDirectory()) walk(file, rel, visited);
      else if (stat.isFile()) {
        files.set(rel, target);
        if (entry.name === 'SKILL.md') {
          entrypoints.add(rel);
          entrypointIdentities[rel] = { dev: stat.dev, ino: stat.ino, hash: digest(fs.readFileSync(target)) };
        }
      } else throw new Error(`Unsupported skill source entry: ${rel}`);
    }
  }
  walk(sourceRoot);

  // agent-browser is one such installed dependency. Inspect declared direct
  // packages' exported skills directories, never recursively scan node_modules.
  for (const component of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (EXCLUDED_DIRECTORIES.has(component.name) || component.name.startsWith('.backup')) continue;
    const componentDir = path.join(sourceRoot, component.name);
    if (!fs.statSync(componentDir).isDirectory()) continue;
    const packageFile = path.join(componentDir, 'package.json');
    if (!exists(packageFile)) continue;
    const pkg = JSON.parse(fs.readFileSync(sourcePath(packageFile), 'utf8'));
    const dependencies = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.optionalDependencies || {})]);
    for (const name of dependencies) {
      if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name)) throw new Error(`Invalid component dependency name: ${name}`);
      const exported = path.join(componentDir, 'node_modules', name, 'skills');
      if (!exists(exported)) continue;
      if (!fs.statSync(sourcePath(exported)).isDirectory()) throw new Error(`Dependency skills export is not a directory: ${name}`);
      walk(exported, `${component.name}/node_modules/${name}/skills`);
    }
  }
  return {
    sourceRoot,
    files: [...files].sort(([a], [b]) => a.localeCompare(b)),
    entrypoints: [...entrypoints].sort(),
    entrypointIdentities: Object.fromEntries(Object.entries(entrypointIdentities).sort(([a], [b]) => a.localeCompare(b))),
    excluded: [...excluded].sort(),
  };
}

function ownedDirectory(directory) {
  if (!exists(directory)) fs.mkdirSync(directory, { mode: 0o755 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new Error(`Unmanaged skill-view directory: ${directory}`);
}

function viewManifest(index) {
  return `${JSON.stringify({ version: 1, sourceRoot: index.sourceRoot, files: index.files, entrypoints: index.entrypoints, entrypointIdentities: index.entrypointIdentities }, null, 2)}\n`;
}

function verifyRelease(release, manifestText, index) {
  const stat = fs.lstatSync(release);
  if (!stat.isDirectory() || stat.uid !== process.getuid()) throw new Error('Unmanaged skill-view release');
  const manifestFile = path.join(release, '.manifest.json');
  if (fs.lstatSync(manifestFile).isSymbolicLink() || fs.readFileSync(manifestFile, 'utf8') !== manifestText) throw new Error('Skill-view manifest mismatch');
  const seen = [];
  const scan = (dir, prefix = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!prefix && entry.name === '.manifest.json') continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(file, relative);
      else if (index.entrypointIdentities[relative]) {
        const identity = index.entrypointIdentities[relative];
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.dev !== identity.dev || stat.ino !== identity.ino || digest(fs.readFileSync(file)) !== identity.hash) throw new Error(`Skill-view entrypoint mismatch: ${relative}`);
        seen.push([relative, new Map(index.files).get(relative)]);
      } else if (entry.isSymbolicLink()) seen.push([relative, path.resolve(path.dirname(file), fs.readlinkSync(file))]);
      else throw new Error(`Unmanaged file in skill view: ${relative}`);
    }
  };
  scan(release);
  seen.sort(([a], [b]) => a.localeCompare(b));
  if (JSON.stringify(seen) !== JSON.stringify(index.files)) throw new Error('Skill-view file-link mismatch');
}

/** Replace only our historical source symlink or an already managed view. */
export function ensureCodexSkillView({ zylosDir, skillsDir = path.join(zylosDir, '.claude', 'skills') }) {
  zylosDir = fs.realpathSync(zylosDir);
  const index = collectCodexSkillFiles(skillsDir);
  const agentsDir = path.join(zylosDir, '.agents');
  ownedDirectory(agentsDir);
  const releases = path.join(agentsDir, '.skill-views');
  ownedDirectory(releases);
  const link = path.join(agentsDir, 'skills');
  const manifestText = viewManifest(index);
  const release = path.join(releases, digest(manifestText));

  function checkCurrent() {
    if (!exists(link)) return 'missing';
    const stat = fs.lstatSync(link);
    if (!stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error('Refusing to replace an unmanaged .agents/skills path');
    const target = path.resolve(agentsDir, fs.readlinkSync(link));
    if (exists(target) && fs.realpathSync(target) === index.sourceRoot) return 'legacy';
    if (path.dirname(target) !== path.resolve(releases)) throw new Error('Unrecognized .agents/skills symlink target');
    const targetStat = fs.lstatSync(target);
    if (!targetStat.isDirectory() || targetStat.uid !== process.getuid()) throw new Error('Unmanaged existing skill-view release');
    const previous = JSON.parse(fs.readFileSync(path.join(target, '.manifest.json'), 'utf8'));
    if (previous.version !== 1 || previous.sourceRoot !== index.sourceRoot) throw new Error('Unrecognized managed skill view');
    return target === path.resolve(release) ? 'current' : 'managed';
  }
  checkCurrent();
  if (!exists(release)) {
    const staging = fs.mkdtempSync(path.join(releases, '.staging-'));
    try {
      for (const [relative, source] of index.files) {
        const target = path.join(staging, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
        // Codex ignores SKILL.md symlinks. Hardlinks appear as regular files
        // and retain source ownership/ACLs; never copy a private source with
        // broader permissions. Zylos source/view share a filesystem. EXDEV
        // is an explicit install error, not permission-losing copy fallback.
        if (index.entrypointIdentities[relative]) fs.linkSync(source, target);
        else fs.symlinkSync(source, target);
      }
      fs.writeFileSync(path.join(staging, '.manifest.json'), manifestText, { mode: 0o644, flag: 'wx' });
      fs.chmodSync(staging, 0o755);
      try { fs.renameSync(staging, release); }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
        verifyRelease(release, manifestText, index);
      }
    } finally { if (exists(staging)) fs.rmSync(staging, { recursive: true, force: true }); }
  }
  verifyRelease(release, manifestText, index);
  const current = checkCurrent();
  let backup = null;
  if (current !== 'current') {
    if (current === 'legacy') {
      const backups = path.join(agentsDir, '.skill-view-backups');
      ownedDirectory(backups);
      backup = path.join(backups, `skills-${Date.now()}-${crypto.randomUUID()}`);
      fs.symlinkSync(fs.readlinkSync(link), backup);
      // A relative legacy link must keep its original meaning in the backup.
      if (!path.isAbsolute(fs.readlinkSync(link))) {
        fs.unlinkSync(backup); fs.symlinkSync(path.resolve(agentsDir, fs.readlinkSync(link)), backup);
      }
    }
    const temporary = path.join(agentsDir, `.skills-next-${crypto.randomUUID()}`);
    try {
      fs.symlinkSync(path.relative(agentsDir, release), temporary);
      checkCurrent();
      fs.renameSync(temporary, link);
    } finally { if (exists(temporary)) fs.unlinkSync(temporary); }
  }
  return { path: link, sourceRoot: index.sourceRoot, release, backup, changed: current !== 'current', skillCount: index.entrypoints.length, fileCount: index.files.length, entrypoints: index.entrypoints, excluded: index.excluded };
}
