import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

// We need to set env vars BEFORE importing the module under test,
// because it reads ZYLOS_DIR and INSTANCES_FILE at import time.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-inject-test-'));
process.env.ZYLOS_DIR = tmpDir;

// Dynamic import after env setup
const { resolveInstanceClaudeMd } = await import('../session-start-inject.js');

describe('resolveInstanceClaudeMd', () => {
  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.ZYLOS_DIR;
  });

  it('returns null when instanceId is null', () => {
    assert.equal(resolveInstanceClaudeMd(null), null);
  });

  it('returns null when instanceId is empty string', () => {
    assert.equal(resolveInstanceClaudeMd(''), null);
  });

  it('returns null when no override file exists', () => {
    assert.equal(resolveInstanceClaudeMd('nonexistent'), null);
  });

  it('resolves convention path ~/zylos/instances/<id>/CLAUDE.md', () => {
    const instanceDir = path.join(tmpDir, 'instances', 'betty');
    fs.mkdirSync(instanceDir, { recursive: true });
    const claudeMdPath = path.join(instanceDir, 'CLAUDE.md');
    fs.writeFileSync(claudeMdPath, '# Betty persona instructions');

    const result = resolveInstanceClaudeMd('betty');
    assert.equal(result, claudeMdPath);
  });

  it('prefers claude_md field from instances.json over convention path', () => {
    // Create convention path
    const conventionDir = path.join(tmpDir, 'instances', 'admin');
    fs.mkdirSync(conventionDir, { recursive: true });
    fs.writeFileSync(path.join(conventionDir, 'CLAUDE.md'), '# Convention');

    // Create explicit path
    const explicitDir = path.join(tmpDir, 'custom-overrides');
    fs.mkdirSync(explicitDir, { recursive: true });
    const explicitPath = path.join(explicitDir, 'admin-override.md');
    fs.writeFileSync(explicitPath, '# Explicit override');

    // Write instances.json with claude_md pointing to explicit path
    fs.writeFileSync(
      path.join(tmpDir, 'instances.json'),
      JSON.stringify({
        version: 1,
        instances: {
          admin: {
            tmux_session: 'claude-admin',
            runtime: 'claude',
            enabled: true,
            type: 'dedicated',
            claude_md: explicitPath
          }
        }
      })
    );

    const result = resolveInstanceClaudeMd('admin');
    assert.equal(result, explicitPath);
  });

  it('falls back to convention path when claude_md field is empty', () => {
    const instanceDir = path.join(tmpDir, 'instances', 'scheduler');
    fs.mkdirSync(instanceDir, { recursive: true });
    const conventionPath = path.join(instanceDir, 'CLAUDE.md');
    fs.writeFileSync(conventionPath, '# Scheduler instructions');

    fs.writeFileSync(
      path.join(tmpDir, 'instances.json'),
      JSON.stringify({
        version: 1,
        instances: {
          scheduler: {
            tmux_session: 'claude-scheduler',
            runtime: 'claude',
            enabled: true,
            type: 'dedicated',
            claude_md: ''
          }
        }
      })
    );

    const result = resolveInstanceClaudeMd('scheduler');
    assert.equal(result, conventionPath);
  });

  it('falls back to convention when claude_md path does not exist on disk', () => {
    const instanceDir = path.join(tmpDir, 'instances', 'fallback');
    fs.mkdirSync(instanceDir, { recursive: true });
    const conventionPath = path.join(instanceDir, 'CLAUDE.md');
    fs.writeFileSync(conventionPath, '# Fallback');

    fs.writeFileSync(
      path.join(tmpDir, 'instances.json'),
      JSON.stringify({
        version: 1,
        instances: {
          fallback: {
            tmux_session: 'claude-fallback',
            runtime: 'claude',
            enabled: true,
            type: 'dedicated',
            claude_md: '/nonexistent/path/CLAUDE.md'
          }
        }
      })
    );

    const result = resolveInstanceClaudeMd('fallback');
    assert.equal(result, conventionPath);
  });

  it('supports tilde expansion in claude_md field', () => {
    const relDir = path.join(tmpDir, 'tilde-test');
    fs.mkdirSync(relDir, { recursive: true });
    const tildeFile = path.join(relDir, 'CLAUDE.md');
    fs.writeFileSync(tildeFile, '# Tilde test');

    // Construct the path with ~ prefix
    const homeDir = os.homedir();
    const tildePath = tildeFile.replace(homeDir, '~');

    fs.writeFileSync(
      path.join(tmpDir, 'instances.json'),
      JSON.stringify({
        version: 1,
        instances: {
          tildetest: {
            tmux_session: 'claude-tildetest',
            runtime: 'claude',
            enabled: true,
            type: 'dedicated',
            claude_md: tildePath
          }
        }
      })
    );

    const result = resolveInstanceClaudeMd('tildetest');
    assert.equal(result, tildeFile);
  });

  it('handles malformed instances.json gracefully', () => {
    fs.writeFileSync(path.join(tmpDir, 'instances.json'), 'NOT JSON');

    // No convention path either
    const result = resolveInstanceClaudeMd('broken');
    assert.equal(result, null);
  });
});
