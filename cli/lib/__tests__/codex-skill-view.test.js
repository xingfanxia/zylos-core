import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { collectCodexSkillFiles, ensureCodexSkillView } from '../codex-skill-view.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skill-view-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const zylosDir = path.join(root, 'zylos');
  const skillsDir = path.join(zylosDir, '.claude', 'skills');
  const put = (relative, content = '') => {
    const file = path.join(skillsDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); return file;
  };
  put('browser/SKILL.md', '---\nname: browser\ndescription: Browser skill\n---\nRead [usage](references/usage.md).\n');
  put('browser/references/usage.md', 'Useful instructions');
  put('browser/references/nested/SKILL.md', '---\nname: nested\ndescription: Nested skill\n---\n');
  put('browser/package.json', '{"type":"module","dependencies":{"agent-browser":"1"}}');
  put('browser/node_modules/agent-browser/package.json', '{"name":"agent-browser"}');
  put('browser/node_modules/agent-browser/skills/agent-browser/SKILL.md', '---\nname: agent-browser\ndescription: Dependency skill\n---\n[commands](references/commands.md)');
  put('browser/node_modules/agent-browser/skills/agent-browser/references/commands.md', 'Commands');
  put('browser/node_modules/agent-browser/bulk/irrelevant.js', 'large dependency implementation');
  put('browser/.zylos/originals/SKILL.md', 'old version');
  put('browser/.backup/old/SKILL.md', 'old version');
  put('browser/.git/config', 'private git config');
  put('browser/__pycache__/large.pyc', 'generated');
  fs.mkdirSync(path.join(zylosDir, '.agents'));
  fs.symlinkSync('../.claude/skills', path.join(zylosDir, '.agents/skills'));
  return { root, zylosDir, skillsDir, put };
}

test('keeps nested and exported dependency skills plus relative files while pruning bulk', t => {
  const f = fixture(t); const index = collectCodexSkillFiles(f.skillsDir);
  assert.deepEqual(index.entrypoints, ['browser/SKILL.md', 'browser/node_modules/agent-browser/skills/agent-browser/SKILL.md', 'browser/references/nested/SKILL.md']);
  const names = index.files.map(([relative]) => relative);
  assert.ok(names.includes('browser/references/usage.md'));
  assert.ok(names.includes('browser/node_modules/agent-browser/skills/agent-browser/references/commands.md'));
  assert.ok(!names.some(name => /\.backup|\.zylos|\/\.git\/|__pycache__|\/bulk\//.test(name)));
});

test('migrates legacy pointer with a usable backup and remains idempotent', t => {
  const f = fixture(t); const result = ensureCodexSkillView(f);
  assert.equal(result.skillCount, 3); assert.ok(result.backup);
  assert.equal(fs.realpathSync(result.backup), fs.realpathSync(f.skillsDir));
  assert.equal(fs.realpathSync(result.path), result.release);
  const original = fs.statSync(path.join(f.skillsDir, 'browser/SKILL.md'));
  const installed = fs.lstatSync(path.join(result.path, 'browser/SKILL.md'));
  assert.ok(installed.isFile());
  assert.deepEqual([installed.dev, installed.ino, installed.uid, installed.gid, installed.mode], [original.dev, original.ino, original.uid, original.gid, original.mode]);
  assert.equal(fs.readFileSync(path.join(result.path, 'browser/references/usage.md'), 'utf8'), 'Useful instructions');
  assert.equal(fs.existsSync(path.join(result.path, 'browser/node_modules/agent-browser/bulk')), false);
  const repeat = ensureCodexSkillView(f);
  assert.equal(repeat.release, result.release); assert.equal(repeat.changed, false); assert.equal(repeat.backup, null);
  assert.equal(fs.readdirSync(path.dirname(result.backup)).length, 1);
});

test('source scripts keep their native dependency resolution through individual file links', async t => {
  const f = fixture(t);
  f.put('browser/node_modules/needed/package.json', '{"main":"index.js"}');
  f.put('browser/node_modules/needed/index.js', 'module.exports = "native-dependency"');
  f.put('browser/scripts/check.js', 'import needed from "needed"; export default needed;');
  const result = ensureCodexSkillView(f);
  const module = await import(pathToFileURL(path.join(result.path, 'browser/scripts/check.js')).href);
  assert.equal(module.default, 'native-dependency');
});

test('publishes newly installed entrypoints and removes retired links without mutating source', t => {
  const f = fixture(t); const first = ensureCodexSkillView(f);
  f.put('new-skill/SKILL.md', '---\nname: new-skill\ndescription: New skill\n---\n');
  fs.unlinkSync(path.join(f.skillsDir, 'browser/references/nested/SKILL.md'));
  const next = ensureCodexSkillView(f);
  assert.notEqual(next.release, first.release); assert.equal(next.skillCount, 3);
  assert.ok(fs.existsSync(path.join(next.path, 'new-skill/SKILL.md')));
  assert.equal(fs.existsSync(path.join(next.path, 'browser/references/nested/SKILL.md')), false);
  assert.ok(fs.existsSync(first.release)); assert.ok(fs.existsSync(path.join(f.skillsDir, 'browser/node_modules/agent-browser/bulk/irrelevant.js')));
});

test('refuses unmanaged paths and outside-source symlinks without switching the live pointer', async t => {
  for (const kind of ['directory', 'unknown-link', 'outside-source', 'cycle']) await t.test(kind, inner => {
    const f = fixture(inner); const link = path.join(f.zylosDir, '.agents/skills');
    if (kind === 'directory') { fs.unlinkSync(link); fs.mkdirSync(link); }
    if (kind === 'unknown-link') { fs.unlinkSync(link); fs.symlinkSync(f.root, link); }
    if (kind === 'outside-source') fs.symlinkSync('/etc/passwd', path.join(f.skillsDir, 'browser/private.md'));
    if (kind === 'cycle') fs.symlinkSync(f.skillsDir, path.join(f.skillsDir, 'browser/cycle'));
    const original = fs.lstatSync(link).isSymbolicLink() ? fs.readlinkSync(link) : null;
    assert.throws(() => ensureCodexSkillView(f));
    if (original) assert.equal(fs.readlinkSync(link), original); else assert.ok(fs.lstatSync(link).isDirectory());
  });
});

test('rejects corrupted existing release files instead of trusting only its manifest', t => {
  const f = fixture(t); const current = ensureCodexSkillView(f);
  const file = path.join(current.release, 'browser/SKILL.md');
  fs.unlinkSync(file); fs.symlinkSync('/etc/passwd', file);
  assert.throws(() => ensureCodexSkillView(f), /entrypoint mismatch/);
});

test('atomic entrypoint replacements produce a fresh inode-backed discovery view', t => {
  const f = fixture(t); const first = ensureCodexSkillView(f);
  const file = path.join(f.skillsDir, 'browser/SKILL.md');
  const nextFile = f.put('browser/SKILL.md.next', fs.readFileSync(file));
  fs.renameSync(nextFile, file);
  const next = ensureCodexSkillView(f);
  assert.notEqual(next.release, first.release);
  assert.equal(fs.statSync(path.join(next.path, 'browser/SKILL.md')).ino, fs.statSync(file).ino);
  assert.notEqual(fs.statSync(path.join(first.release, 'browser/SKILL.md')).ino, fs.statSync(file).ino);
});
