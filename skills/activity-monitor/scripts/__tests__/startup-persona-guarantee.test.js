import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { DEFAULT_SHARD_BUDGET, estimateTokens, withinBudget } from '../shard-registry.js';
import { composeShardOutput, runSessionStartShard, shardHeader } from '../session-start-orchestrator.js';
import {
  emitMemoryPart,
  getStartupMemoryContextParts,
  injectMemory,
} from '../../../zylos-memory/scripts/session-start-inject.js';
import { formatSection } from '../../../comm-bridge/scripts/session-format.js';

// Synthetic text with the live files' shape: mostly CJK, line-oriented
// markdown. Sizes below mirror ax-devbox on 2026-11-17 (state.md 7-10 KB,
// shared identity.md 3.5 KB, references.md 4.2 KB, instance ZYLOS.md ~0.6 KB).
function cjkLines(count, prefix) {
  return Array.from({ length: count }, (_, index) =>
    `- ${prefix}${index + 1}: 示例条目内容用于测试启动上下文预算的长度与裁剪行为 (2026-11-${String((index % 28) + 1).padStart(2, '0')})`).join('\n');
}

function realisticState() {
  return [
    '# user-test Instance State',
    'Last updated: 2026-11-16 21:00',
    '',
    '## Current Focus',
    cjkLines(30, '当前'),
    '',
    '## Pending / Waiting',
    cjkLines(36, '待办'),
    '',
    '## Working Pointers and Boundaries',
    cjkLines(24, '边界'),
  ].join('\n');
}

const PERSONA_TEXT = [
  'You are the test-persona instance. Serve ONLY the user in your assigned chat.',
  '你只服务这一位用户；不要读取或引用其他实例的私有文件。',
  'Standing rule: 文案和图片分开发送。',
].join('\n');

let zylosDir;
const savedEnv = {};

function makeZylos({ instanceId = 'user-test', type = 'user', primary = false, state = realisticState(), identity = null, digest = null } = {}) {
  zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-guarantee-'));
  const shared = path.join(zylosDir, 'memory', 'shared');
  fs.mkdirSync(shared, { recursive: true });
  fs.mkdirSync(path.join(zylosDir, 'memory', 'instances', instanceId), { recursive: true });
  fs.mkdirSync(path.join(zylosDir, 'instances', instanceId), { recursive: true });
  fs.writeFileSync(path.join(shared, 'identity.md'), identity ?? `# Bot Identity\n${cjkLines(18, '身份')}\n`);
  fs.writeFileSync(path.join(shared, 'references.md'), `# References\n${cjkLines(40, '指针')}\n`);
  if (digest) fs.writeFileSync(path.join(shared, 'recent-activity.md'), digest);
  fs.writeFileSync(path.join(zylosDir, 'memory', 'instances', instanceId, 'state.md'), state);
  fs.writeFileSync(path.join(zylosDir, 'instances', instanceId, 'ZYLOS.md'), PERSONA_TEXT);
  fs.writeFileSync(path.join(zylosDir, 'instances.json'), JSON.stringify({
    scheduler_instance: 'scheduler',
    instances: { [instanceId]: { type, primary, runtime: 'claude' } },
  }));
  process.env.ZYLOS_DIR = zylosDir;
  process.env.ZYLOS_INSTANCE_ID = instanceId;
  return zylosDir;
}

function compose(name, body) {
  return composeShardOutput({
    header: shardHeader({ position: 1, total: 6, name }),
    body,
    budget: DEFAULT_SHARD_BUDGET,
    spillPath: '/tmp/spill/x.txt',
  });
}

function complete(output, label) {
  return output.includes(`=== ${label} ===`) && output.includes(`=== END ${label} ===`);
}

beforeEach(() => {
  for (const key of ['ZYLOS_DIR', 'ZYLOS_INSTANCE_ID']) savedEnv[key] = process.env[key];
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (zylosDir) fs.rmSync(zylosDir, { recursive: true, force: true });
  zylosDir = null;
});

describe('startup persona block survives realistic state sizes', () => {
  it('fixture state is over the shard budget on its own, like the live files', () => {
    makeZylos();
    const state = fs.readFileSync(path.join(zylosDir, 'memory', 'instances', 'user-test', 'state.md'), 'utf8');
    assert.ok(estimateTokens(state) > DEFAULT_SHARD_BUDGET.maxTokens, `state is ${estimateTokens(state)} tokens`);
  });

  it('reproduces the defect: persona appended after state in one trimmed body is cut off', () => {
    makeZylos();
    // The pre-fix 'state' shard body: state, then write policy, then the
    // instance instructions, composed as one string whose tail is trimmed.
    const state = fs.readFileSync(path.join(zylosDir, 'memory', 'instances', 'user-test', 'state.md'), 'utf8');
    const oldBody = [
      formatSection('ACTIVE STATE', state),
      formatSection('MEMORY WRITE POLICY', 'Allowed writes: memory/instances/user-test/...'),
      formatSection('INSTANCE INSTRUCTIONS', PERSONA_TEXT),
    ].join('\n\n');
    const { output, truncated } = compose('state', oldBody);
    assert.equal(truncated, true);
    assert.equal(output.includes('INSTANCE INSTRUCTIONS'), false);
    assert.equal(output.includes('MEMORY WRITE POLICY'), false);
  });

  it('the identity shard emits the persona block first, whole, ahead of the shared identity', () => {
    makeZylos();
    const { output } = compose('identity', emitMemoryPart('identity'));
    assert.ok(complete(output, 'INSTANCE INSTRUCTIONS'));
    assert.ok(complete(output, 'MEMORY WRITE POLICY'));
    assert.ok(output.includes(PERSONA_TEXT));
    const order = ['INSTANCE INSTRUCTIONS', 'MEMORY WRITE POLICY', 'BOT IDENTITY'].map(label => output.indexOf(`=== ${label} ===`));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
    assert.ok(withinBudget(output, DEFAULT_SHARD_BUDGET));
  });

  it('a huge shared identity.md is trimmed, never the persona block', () => {
    makeZylos({ identity: `# Bot Identity\n${cjkLines(400, '身份')}\n` });
    const composed = compose('identity', emitMemoryPart('identity'));
    assert.equal(composed.truncated, true);
    assert.equal(composed.guaranteedTrimmed, false);
    assert.ok(complete(composed.output, 'INSTANCE INSTRUCTIONS'));
    assert.ok(complete(composed.output, 'MEMORY WRITE POLICY'));
    assert.equal(composed.trimmedLabel, 'BOT IDENTITY');
    assert.match(composed.output, /\[trimmed to fit the startup budget: BOT IDENTITY kept its first \d+ of \d+ chars/);
    assert.ok(composed.output.includes(path.join(zylosDir, 'memory', 'shared', 'identity.md')));
    assert.ok(withinBudget(composed.output, DEFAULT_SHARD_BUDGET));
  });

  it('state is trimmed from its end at a line boundary, with a marker naming state.md', () => {
    makeZylos();
    const statePath = path.join(zylosDir, 'memory', 'instances', 'user-test', 'state.md');
    const composed = compose('state', emitMemoryPart('state'));
    assert.equal(composed.truncated, true);
    assert.equal(composed.trimmedLabel, 'ACTIVE STATE');
    assert.ok(composed.output.includes('## Current Focus'));
    assert.ok(composed.output.includes(`read the full text in: ${statePath}`));
    assert.ok(withinBudget(composed.output, DEFAULT_SHARD_BUDGET));
    // The last inline line is a complete line of state.md.
    const inline = composed.output.split('\n[trimmed to fit')[0];
    const lastLine = inline.split('\n').at(-1);
    assert.ok(fs.readFileSync(statePath, 'utf8').split('\n').includes(lastLine), `partial line: ${lastLine}`);
    // The persona block lives in the identity shard, not here.
    assert.equal(composed.output.includes('INSTANCE INSTRUCTIONS'), false);
  });

  it('the cross-instance digest is dropped before state is cut', () => {
    makeZylos({
      instanceId: 'admin',
      type: 'dedicated',
      primary: true,
      state: `# Active State\n${cjkLines(20, '状态')}\n`,
      digest: `# Recent activity\n${cjkLines(100, '动态')}\n`,
    });
    const statePath = path.join(zylosDir, 'memory', 'instances', 'admin', 'state.md');
    const composed = compose('state', emitMemoryPart('state'));
    assert.equal(composed.truncated, true);
    assert.ok(complete(composed.output, 'ACTIVE STATE'));
    assert.ok(fs.readFileSync(statePath, 'utf8').trim().split('\n').every(line => composed.output.includes(line)));
    assert.equal(composed.trimmedLabel, 'CROSS-INSTANCE CONTEXT');
    assert.ok(withinBudget(composed.output, DEFAULT_SHARD_BUDGET));
  });

  it('an oversized persona block is cut with a visible marker and still fits the budget', () => {
    makeZylos();
    fs.writeFileSync(path.join(zylosDir, 'instances', 'user-test', 'ZYLOS.md'), cjkLines(300, '超长'));
    const composed = compose('identity', emitMemoryPart('identity'));
    assert.equal(composed.guaranteedTrimmed, true);
    assert.match(composed.output, /persona section exceeded the shard budget/);
    assert.ok(withinBudget(composed.output, DEFAULT_SHARD_BUDGET));
  });

  it('the marker names headings that were cut, so a tail standing-rules section is findable', () => {
    const text = formatSection('ACTIVE STATE', [
      '## Current Focus',
      cjkLines(120, '当前'),
      '## Working Pointers and Boundaries',
      cjkLines(5, '边界'),
    ].join('\n'));
    const composed = compose('state', { sections: [{ label: 'ACTIVE STATE', text, path: '/z/state.md' }] });
    assert.match(composed.output, /cut headings: ## Working Pointers and Boundaries/);
    assert.ok(withinBudget(composed.output, DEFAULT_SHARD_BUDGET));
  });

  it('stays within budget across section sizes (chars and tokens)', () => {
    for (const lines of [1, 5, 20, 40, 80, 160]) {
      for (const ascii of [false, true]) {
        const text = ascii ? 'x'.repeat(lines * 120) : cjkLines(lines, '测');
        const composed = compose('state', {
          guaranteed: formatSection('INSTANCE INSTRUCTIONS', PERSONA_TEXT),
          sections: [
            { label: 'ACTIVE STATE', text: formatSection('ACTIVE STATE', text), path: '/z/state.md' },
            { label: 'CROSS-INSTANCE CONTEXT', text: formatSection('CROSS-INSTANCE CONTEXT', text), path: '/z/recent.md' },
          ],
        });
        assert.ok(withinBudget(composed.output, DEFAULT_SHARD_BUDGET), `lines=${lines} ascii=${ascii}`);
        assert.ok(composed.output.includes(PERSONA_TEXT), `lines=${lines} ascii=${ascii}`);
      }
    }
  });

  it('runs end to end through the identity shard hook with the real registry', async () => {
    makeZylos();
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-stdout-'));
    const outPath = path.join(outDir, 'out.txt');
    const fd = fs.openSync(outPath, 'w+');
    try {
      await runSessionStartShard('identity', { source: 'startup' }, {
        stdout: { fd },
        zylosDir,
        tmpdir: outDir,
        registerExitFlagImpl: () => {},
      });
    } finally {
      fs.closeSync(fd);
    }
    const output = fs.readFileSync(outPath, 'utf8');
    fs.rmSync(outDir, { recursive: true, force: true });
    assert.match(output, /^=== ZYLOS STARTUP CONTEXT \[1\/6\] identity ===/);
    assert.ok(output.indexOf('=== INSTANCE INSTRUCTIONS ===') < output.indexOf('=== BOT IDENTITY ==='));
    assert.ok(complete(output, 'MEMORY WRITE POLICY'));
  });

  it('the legacy single block puts the persona first, inside the inline preview', () => {
    makeZylos();
    const parts = getStartupMemoryContextParts();
    assert.match(parts[0], /^=== INSTANCE INSTRUCTIONS ===/);
    assert.match(parts[1], /^=== MEMORY WRITE POLICY ===/);
    const text = injectMemory();
    assert.ok(text.indexOf('=== END MEMORY WRITE POLICY ===') < 2000);
  });

  it('single-session mode (no instance) has no persona block and keeps plain sections', () => {
    makeZylos();
    delete process.env.ZYLOS_INSTANCE_ID;
    const body = emitMemoryPart('identity');
    assert.equal(body.guaranteed, '');
    assert.equal(body.sections[0].label, 'BOT IDENTITY');
  });
});
