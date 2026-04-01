import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  describeMemoryWritePolicy,
  validateMemoryWrite,
} from '../skills/multi-session/memory-policy.js';
import {
  getInstanceInstructionFiles,
  getInstanceStateFile,
} from '../skills/multi-session/runtime-files.js';
import {
  getStartupMemoryContextParts,
} from '../skills/zylos-memory/scripts/session-start-inject.js';

describe('Mixed-runtime memory safety helpers', () => {
  let tmpDir;
  let zylosDir;
  let memoryDir;
  let instancesFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-mixed-memory-test-'));
    zylosDir = path.join(tmpDir, 'zylos');
    memoryDir = path.join(zylosDir, 'memory');
    instancesFile = path.join(zylosDir, 'instances.json');

    fs.mkdirSync(path.join(memoryDir, 'shared', 'reference'), { recursive: true });
    fs.mkdirSync(path.join(memoryDir, 'shared', 'users'), { recursive: true });
    fs.mkdirSync(path.join(memoryDir, 'archive'), { recursive: true });
    fs.mkdirSync(path.join(memoryDir, 'instances', 'admin'), { recursive: true });
    fs.mkdirSync(path.join(memoryDir, 'instances', 'user-betty'), { recursive: true });
    fs.mkdirSync(path.join(zylosDir, '.zylos'), { recursive: true });
    fs.mkdirSync(path.join(zylosDir, 'instances', 'user-betty'), { recursive: true });

    fs.writeFileSync(path.join(zylosDir, '.zylos', 'config.json'), JSON.stringify({ runtime: 'claude' }, null, 2));
    fs.writeFileSync(instancesFile, JSON.stringify({
      version: 1,
      default_instance: 'admin',
      scheduler_instance: 'scheduler',
      instances: {
        admin: { primary: true, runtime: 'claude' },
        scheduler: { primary: false, runtime: 'claude' },
        'user-betty': { primary: false, runtime: 'codex' },
      },
    }, null, 2));

    fs.writeFileSync(path.join(memoryDir, 'shared', 'identity.md'), 'identity', 'utf8');
    fs.writeFileSync(path.join(memoryDir, 'shared', 'references.md'), 'references', 'utf8');
    fs.writeFileSync(path.join(memoryDir, 'instances', 'user-betty', 'state.md'), 'state', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('blocks non-primary writes to shared and archive memory', () => {
    const sharedResult = validateMemoryWrite(path.join(memoryDir, 'shared', 'reference', 'projects.md'), {
      zylosDir,
      memoryDir,
      instanceId: 'user-betty',
      instancesFilePath: instancesFile,
    });
    const archiveResult = validateMemoryWrite(path.join(memoryDir, 'archive', '2026-04.md'), {
      zylosDir,
      memoryDir,
      instanceId: 'user-betty',
      instancesFilePath: instancesFile,
    });

    expect(sharedResult).toContain('shared memory');
    expect(archiveResult).toContain('shared memory');
  });

  it('allows only users/<id>/profile.md in shared user memory for non-primary instances', () => {
    const allowed = validateMemoryWrite(path.join(memoryDir, 'shared', 'users', 'betty', 'profile.md'), {
      zylosDir,
      memoryDir,
      instanceId: 'user-betty',
      instancesFilePath: instancesFile,
    });
    const blocked = validateMemoryWrite(path.join(memoryDir, 'shared', 'users', 'betty', 'notes.md'), {
      zylosDir,
      memoryDir,
      instanceId: 'user-betty',
      instancesFilePath: instancesFile,
    });

    expect(allowed).toBeNull();
    expect(blocked).toContain('Only users/<id>/profile.md');
  });

  it('resolves symlinked shared directories when validating new file writes', () => {
    fs.rmSync(path.join(memoryDir, 'users'), { recursive: true, force: true });
    fs.symlinkSync(path.join(memoryDir, 'shared', 'users'), path.join(memoryDir, 'users'));

    const allowed = validateMemoryWrite(path.join(memoryDir, 'users', 'u123', 'profile.md'), {
      zylosDir,
      memoryDir,
      instanceId: 'user-betty',
      instancesFilePath: instancesFile,
    });
    const blocked = validateMemoryWrite(path.join(memoryDir, 'users', 'u123', 'scratch.md'), {
      zylosDir,
      memoryDir,
      instanceId: 'user-betty',
      instancesFilePath: instancesFile,
    });

    expect(allowed).toBeNull();
    expect(blocked).toContain('Only users/<id>/profile.md');
  });

  it('blocks direct top-level memory writes in multi-session mode', () => {
    const result = validateMemoryWrite(path.join(memoryDir, 'rogue.md'), {
      zylosDir,
      memoryDir,
      instanceId: 'user-betty',
      instancesFilePath: instancesFile,
    });

    expect(result).toContain('top-level memory path');
  });

  it('describes non-primary write policy clearly', () => {
    const policy = describeMemoryWritePolicy({
      instanceId: 'user-betty',
      instancesFilePath: instancesFile,
    });

    expect(policy).toContain("Instance 'user-betty' is a non-primary worker/user instance");
    expect(policy).toContain('memory/instances/user-betty/');
    expect(policy).toContain('memory/shared/');
  });

  it('returns instance-specific state path when instances/ exists', () => {
    const statePath = getInstanceStateFile({
      zylosDir,
      instanceId: 'user-betty',
    });

    expect(statePath).toBe(path.join(memoryDir, 'instances', 'user-betty', 'state.md'));
  });

  it('skips default root instruction symlinks but keeps custom runtime-specific files', () => {
    fs.writeFileSync(path.join(zylosDir, 'AGENTS.md'), 'root agents', 'utf8');
    fs.writeFileSync(path.join(zylosDir, 'CLAUDE.md'), 'root claude', 'utf8');
    fs.writeFileSync(path.join(zylosDir, 'ZYLOS.md'), 'root zylos', 'utf8');

    fs.symlinkSync('../../AGENTS.md', path.join(zylosDir, 'instances', 'user-betty', 'AGENTS.md'));
    fs.symlinkSync('../../CLAUDE.md', path.join(zylosDir, 'instances', 'user-betty', 'CLAUDE.md'));
    fs.writeFileSync(path.join(zylosDir, 'instances', 'user-betty', 'ZYLOS.md'), 'custom instance instructions', 'utf8');

    const initial = getInstanceInstructionFiles({
      zylosDir,
      instanceId: 'user-betty',
      runtime: 'codex',
    });
    expect(initial).toEqual([
      {
        label: 'INSTANCE INSTRUCTIONS',
        path: path.join(zylosDir, 'instances', 'user-betty', 'ZYLOS.md'),
      },
    ]);

    fs.rmSync(path.join(zylosDir, 'instances', 'user-betty', 'AGENTS.md'));
    fs.writeFileSync(path.join(zylosDir, 'instances', 'user-betty', 'AGENTS.md'), 'custom codex instructions', 'utf8');

    const withCustomCodex = getInstanceInstructionFiles({
      zylosDir,
      instanceId: 'user-betty',
      runtime: 'codex',
    });
    expect(withCustomCodex).toEqual([
      {
        label: 'INSTANCE INSTRUCTIONS',
        path: path.join(zylosDir, 'instances', 'user-betty', 'ZYLOS.md'),
      },
      {
        label: 'INSTANCE RUNTIME INSTRUCTIONS',
        path: path.join(zylosDir, 'instances', 'user-betty', 'AGENTS.md'),
      },
    ]);
  });

  it('falls back to custom legacy CLAUDE.md for codex instances when AGENTS.md is absent', () => {
    fs.writeFileSync(path.join(zylosDir, 'CLAUDE.md'), 'root claude', 'utf8');
    fs.writeFileSync(path.join(zylosDir, 'instances', 'user-betty', 'CLAUDE.md'), 'legacy custom claude', 'utf8');

    const files = getInstanceInstructionFiles({
      zylosDir,
      instanceId: 'user-betty',
      runtime: 'codex',
    });

    expect(files).toEqual([
      {
        label: 'LEGACY INSTANCE RUNTIME INSTRUCTIONS',
        path: path.join(zylosDir, 'instances', 'user-betty', 'CLAUDE.md'),
      },
    ]);
  });

  it('injects memory policy and custom instance instructions into startup context', () => {
    fs.writeFileSync(path.join(zylosDir, 'instances', 'user-betty', 'AGENTS.md'), 'custom codex instructions', 'utf8');

    const parts = getStartupMemoryContextParts({
      zylosDir,
      instanceId: 'user-betty',
      runtime: 'codex',
    });
    const combined = parts.join('\n\n');

    expect(combined).toContain('=== MEMORY WRITE POLICY ===');
    expect(combined).toContain("Allowed writes: memory/instances/user-betty/");
    expect(combined).toContain('=== INSTANCE RUNTIME INSTRUCTIONS ===');
    expect(combined).toContain('custom codex instructions');
  });
});
