import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  buildStartupReport,
  formatReport,
  hookDuplication,
  parseReportArgs,
  splitLabeled,
} from '../startup-context-report.js';

const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-report-'));
const savedEnv = { ZYLOS_DIR: process.env.ZYLOS_DIR, ZYLOS_INSTANCE_ID: process.env.ZYLOS_INSTANCE_ID };

after(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(zylosDir, { recursive: true, force: true });
});

fs.mkdirSync(path.join(zylosDir, 'memory', 'shared'), { recursive: true });
fs.mkdirSync(path.join(zylosDir, 'memory', 'instances', 'user-a'), { recursive: true });
fs.mkdirSync(path.join(zylosDir, 'instances', 'user-a'), { recursive: true });
fs.mkdirSync(path.join(zylosDir, '.claude'), { recursive: true });
fs.writeFileSync(path.join(zylosDir, 'memory', 'shared', 'identity.md'), 'Shared identity');
fs.writeFileSync(path.join(zylosDir, 'memory', 'shared', 'references.md'), 'Refs');
fs.writeFileSync(path.join(zylosDir, 'memory', 'instances', 'user-a', 'state.md'), 'State');
fs.writeFileSync(path.join(zylosDir, 'instances', 'user-a', 'ZYLOS.md'), 'You are instance A.');
fs.writeFileSync(path.join(zylosDir, 'instances.json'), JSON.stringify({ instances: { 'user-a': { type: 'user' } } }));
const orchestrator = '/z/.claude/skills/activity-monitor/scripts/session-start-orchestrator.js';
fs.writeFileSync(path.join(zylosDir, '.claude', 'settings.json'), JSON.stringify({
  hooks: {
    SessionStart: [{ matcher: 'startup', hooks: [
      { type: 'command', command: `node ${orchestrator}` },
      { type: 'command', command: `node ${orchestrator} --shard identity` },
    ] }],
    Stop: [{ hooks: [
      { type: 'command', command: 'node ~/zylos/.claude/skills/activity-monitor/scripts/hook-activity.js' },
      { type: 'command', command: 'node /z/.claude/skills/activity-monitor/scripts/hook-activity.js' },
    ] }],
  },
}));

describe('startup-context-report', () => {
  it('derives zylos dir and instance from an instance directory', () => {
    const args = parseReportArgs(['--instance-dir', path.join(zylosDir, 'instances', 'user-a')]);
    assert.equal(args.zylosDir, zylosDir);
    assert.equal(args.instanceId, 'user-a');
  });

  it('lists sections in emission order with guaranteed flags, legacy block and duplicate hooks', async () => {
    const report = await buildStartupReport({ zylosDir, instanceId: 'user-a' });
    const sections = report.rows.map(row => `${row.shard}:${row.section}:${row.guaranteed}:${row.status}`);
    assert.deepEqual(sections, [
      'identity:INSTANCE INSTRUCTIONS:true:full',
      'identity:MEMORY WRITE POLICY:true:full',
      'identity:BOT IDENTITY:false:full',
      'references:REFERENCES:false:full',
      'state:ACTIVE STATE:false:full',
    ]);
    assert.deepEqual(report.shards.filter(shard => !shard.measured).map(shard => shard.shard), ['c4-checkpoint', 'c4-conversations']);
    assert.equal(report.legacy.registered, true);
    assert.ok(report.legacy.memoryChars > 0);
    const text = formatReport(report);
    assert.match(text, /Legacy no-argument orchestrator: REGISTERED/);
    assert.match(text, /Stop\[\] 2 commands \/ 1 scripts/);
  });

  it('splits labeled blocks and counts duplicate spellings', () => {
    assert.deepEqual(splitLabeled('=== A ===\nx\n=== END A ===\n\n=== B ===\ny').map(item => item.label), ['A', 'B']);
    const rows = hookDuplication({ hooks: { PreToolUse: [{ hooks: [
      { type: 'command', command: 'node ~/z/a.js' },
      { type: 'command', command: 'node /z/a.js' },
      { type: 'command', command: 'node /z/b.js' },
    ] }] } });
    assert.deepEqual(rows, [{ event: 'PreToolUse', matcher: '', commands: 3, unique: 2 }]);
  });
});
