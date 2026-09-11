import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

const tmpDirs = [];

const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-claude-fakebin-'));
const fakeClaudePath = path.join(fakeBinDir, 'claude');
const envCapturePath = path.join(fakeBinDir, 'env.json');
const fakeZylosDir = path.join(fakeBinDir, 'zylos');
fs.writeFileSync(
  fakeClaudePath,
  `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(process.env.FAKE_CLAUDE_ENV_OUT, JSON.stringify({
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || '',
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN || '',
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || '',
  CLAUDECODE: process.env.CLAUDECODE || '',
  CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT || ''
}));
const mode = process.env.FAKE_CLAUDE_MODE || 'success';
if (mode === 'success') {
  console.log('pong');
  process.exit(0);
}
if (mode === 'not_logged_in_stdout') {
  console.log('Not logged in');
  process.exit(0);
}
if (mode === 'auth_error') {
  console.error('authentication_error');
  process.exit(1);
}
if (mode === 'rate_limit') {
  console.error('rate_limit_error');
  process.exit(1);
}
console.error('unknown failure');
process.exit(1);
`,
  { mode: 0o755 }
);

process.env.CLAUDE_BIN = fakeClaudePath;
process.env.FAKE_CLAUDE_ENV_OUT = envCapturePath;
process.env.ZYLOS_DIR = fakeZylosDir;

after(() => { try { fs.rmSync(fakeBinDir, { recursive: true, force: true }); } catch {} });

const { ClaudeAdapter } = await import('../runtime/claude.js');

let originalHome;
let originalZylosDir;
let originalClaudeCode;
let originalClaudeCodeEntrypoint;
let originalOauthToken;
let originalApiKey;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalZylosDir = process.env.ZYLOS_DIR;
  originalClaudeCode = process.env.CLAUDECODE;
  originalClaudeCodeEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  // Hermetic: credential resolution reads process.env first, so an ambient
  // token in the test shell would leak into every checkAuth. Clear both and let
  // each test control the credential via fixtures.
  originalOauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  originalApiKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-claude-auth-home-'));
  tmpDirs.push(tmpHome);
  fs.rmSync(fakeZylosDir, { recursive: true, force: true });
  fs.mkdirSync(fakeZylosDir, { recursive: true });
  fs.writeFileSync(
    path.join(fakeZylosDir, '.env'),
    [
      'ANTHROPIC_API_KEY=sk-ant-test',
      'CLAUDE_CODE_OAUTH_TOKEN=oauth-test',
      'ANTHROPIC_BASE_URL=https://claude-proxy.example.com',
      '',
    ].join('\n'),
    'utf8'
  );
  process.env.HOME = tmpHome;
  process.env.ZYLOS_DIR = fakeZylosDir;
  process.env.CLAUDECODE = '1';
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
});

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalZylosDir === undefined) delete process.env.ZYLOS_DIR;
  else process.env.ZYLOS_DIR = originalZylosDir;
  if (originalClaudeCode === undefined) delete process.env.CLAUDECODE;
  else process.env.CLAUDECODE = originalClaudeCode;
  if (originalClaudeCodeEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
  else process.env.CLAUDE_CODE_ENTRYPOINT = originalClaudeCodeEntrypoint;
  if (originalOauthToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauthToken;
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalApiKey;
  delete process.env.FAKE_CLAUDE_MODE;
});

describe('Claude auth checks', () => {
  it('returns success and injects Anthropic credentials plus base URL into the probe env', async () => {
    process.env.FAKE_CLAUDE_MODE = 'success';

    const result = await new ClaudeAdapter({}).checkAuth();
    const env = JSON.parse(fs.readFileSync(envCapturePath, 'utf8'));

    assert.equal(result.status, 'success');
    assert.equal(result.reason, 'cli_probe');
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-test');
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-test');
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://claude-proxy.example.com');
    assert.equal(env.CLAUDECODE, '');
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, '');
  });

  it('returns failure for explicit logged-out and authentication-error signals', async () => {
    const adapter = new ClaudeAdapter({});

    process.env.FAKE_CLAUDE_MODE = 'not_logged_in_stdout';
    assert.equal((await adapter.checkAuth()).status, 'failure');

    process.env.FAKE_CLAUDE_MODE = 'auth_error';
    const result = await adapter.checkAuth();
    assert.equal(result.status, 'failure');
    assert.equal(result.reason, 'cli_probe_authentication_error');
  });

  it('returns uncertain for transient probe failures', async () => {
    process.env.FAKE_CLAUDE_MODE = 'rate_limit';

    const result = await new ClaudeAdapter({}).checkAuth();

    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'cli_probe_uncertain');
  });
});

describe('checkAuth credential fast-path (deterministic, no probe)', () => {
  // sk-ant- prefix, >= 40 chars → passes the `usable()` format+length gate.
  const LONG_TOKEN = 'sk-ant-oat01-' + 'A'.repeat(80);

  it('returns success from a settings.local.json env token WITHOUT spawning the probe', async () => {
    // If the probe ran it would FAIL (auth_error) — proving the fast-path skipped it.
    process.env.FAKE_CLAUDE_MODE = 'auth_error';
    fs.rmSync(envCapturePath, { force: true });
    const claudeDir = path.join(fakeZylosDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.local.json'),
      JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: LONG_TOKEN } })
    );

    const result = await new ClaudeAdapter({}).checkAuth();

    assert.equal(result.status, 'success');
    assert.match(result.reason, /^credential_present:/);
    assert.equal(fs.existsSync(envCapturePath), false); // probe never spawned
  });

  it('returns success from ~/.claude/.credentials.json claudeAiOauth with a future expiry', async () => {
    process.env.FAKE_CLAUDE_MODE = 'auth_error';
    fs.rmSync(envCapturePath, { force: true });
    const homeClaude = path.join(process.env.HOME, '.claude');
    fs.mkdirSync(homeClaude, { recursive: true });
    fs.writeFileSync(
      path.join(homeClaude, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: LONG_TOKEN, refreshToken: '', expiresAt: Date.now() + 315e8 } })
    );

    const result = await new ClaudeAdapter({}).checkAuth();

    assert.equal(result.status, 'success');
    assert.match(result.reason, /^credential_present:credentials\.json/);
    assert.equal(fs.existsSync(envCapturePath), false);
  });

  it('ignores an EXPIRED creds-file token and falls through to the live probe', async () => {
    process.env.FAKE_CLAUDE_MODE = 'success';
    fs.rmSync(envCapturePath, { force: true });
    const homeClaude = path.join(process.env.HOME, '.claude');
    fs.mkdirSync(homeClaude, { recursive: true });
    fs.writeFileSync(
      path.join(homeClaude, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: LONG_TOKEN, expiresAt: Date.now() - 1000 } })
    );

    const result = await new ClaudeAdapter({}).checkAuth();

    assert.equal(result.status, 'success');
    assert.equal(result.reason, 'cli_probe');       // probe DID run
    assert.equal(fs.existsSync(envCapturePath), true);
  });

  it('does not treat a short/placeholder token as a credential (falls through to probe)', async () => {
    // beforeEach's .env has CLAUDE_CODE_OAUTH_TOKEN=oauth-test and
    // ANTHROPIC_API_KEY=sk-ant-test — both too short/ill-formed to be usable.
    process.env.FAKE_CLAUDE_MODE = 'success';
    fs.rmSync(envCapturePath, { force: true });

    const result = await new ClaudeAdapter({}).checkAuth();

    assert.equal(result.status, 'success');
    assert.equal(result.reason, 'cli_probe');       // fell through, probe ran
    assert.equal(fs.existsSync(envCapturePath), true);
  });

  it('does NOT let a settings.local.json mirror mask an EXPIRED creds-file token', async () => {
    // Real fleet layout: the SAME token lives in both files, only the creds-file
    // carries expiry. An expired creds-file must win over its expiry-less mirror
    // and fall through to the probe (so a genuine expiry → clean auth_failed).
    process.env.FAKE_CLAUDE_MODE = 'success';
    fs.rmSync(envCapturePath, { force: true });
    const claudeDir = path.join(fakeZylosDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.local.json'),
      JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: LONG_TOKEN } })
    );
    const homeClaude = path.join(process.env.HOME, '.claude');
    fs.mkdirSync(homeClaude, { recursive: true });
    fs.writeFileSync(
      path.join(homeClaude, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: LONG_TOKEN, expiresAt: Date.now() - 1000 } })
    );

    const result = await new ClaudeAdapter({}).checkAuth();

    assert.equal(result.status, 'success');
    assert.equal(result.reason, 'cli_probe');       // fell through despite settings mirror
    assert.equal(fs.existsSync(envCapturePath), true);
  });

  it('treats a malformed creds-file expiresAt as untrusted (falls through to probe)', async () => {
    process.env.FAKE_CLAUDE_MODE = 'success';
    fs.rmSync(envCapturePath, { force: true });
    const homeClaude = path.join(process.env.HOME, '.claude');
    fs.mkdirSync(homeClaude, { recursive: true });
    fs.writeFileSync(
      path.join(homeClaude, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: LONG_TOKEN, expiresAt: 'garbage' } })
    );

    const result = await new ClaudeAdapter({}).checkAuth();

    assert.equal(result.status, 'success');
    assert.equal(result.reason, 'cli_probe');       // malformed expiry → not trusted
    assert.equal(fs.existsSync(envCapturePath), true);
  });
});
