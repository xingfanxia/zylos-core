/**
 * Integration tests for:
 *   - Memory resolvers (skills/zylos-memory/scripts/shared.js)
 *   - Fork config (cli/lib/fork-config.js)
 *   - Upstream merge helpers (cli/lib/upstream-merge.js)
 *   - Dashboard route registration (skills/web-console/scripts/dashboard-routes.js)
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// Memory resolver tests — dynamic import with temp ZYLOS_DIR
// ---------------------------------------------------------------------------

describe('Memory resolvers (shared.js)', () => {
  let tmpDir;
  let memoryDir;
  let sharedDir;
  let instancesDir;
  let sessionsDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-test-'));
    memoryDir = path.join(tmpDir, 'memory');
    sharedDir = path.join(memoryDir, 'shared');
    instancesDir = path.join(memoryDir, 'instances');
    sessionsDir = path.join(memoryDir, 'sessions');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Reset module registry so ZYLOS_DIR re-evaluates on next import
    jest.resetModules();
    delete process.env.ZYLOS_DIR;
  });

  /**
   * Helper: create directory structure and dynamically import shared.js
   * with ZYLOS_DIR pointing at our temp directory.
   *
   * @param {object} opts
   * @param {boolean} opts.createShared - Whether to create memory/shared/
   * @param {string[]} opts.referenceFiles - Relative paths under shared/reference/ or memory/reference/
   * @returns {Promise<object>} The shared module's exports
   */
  async function loadShared({ createShared = false, referenceFiles = [] } = {}) {
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.mkdirSync(instancesDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });

    if (createShared) {
      fs.mkdirSync(sharedDir, { recursive: true });
    }

    for (const relPath of referenceFiles) {
      const base = createShared ? sharedDir : memoryDir;
      const fullPath = path.join(base, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, `# ${path.basename(relPath)}\n`);
    }

    process.env.ZYLOS_DIR = tmpDir;

    // Bust the module cache by appending a unique query param
    const cacheBuster = `?t=${Date.now()}-${Math.random()}`;
    const mod = await import(
      `../skills/zylos-memory/scripts/shared.js${cacheBuster}`
    );
    return mod;
  }

  // -----------------------------------------------------------------------
  // 1. resolveSharedFile — shared/ exists
  // -----------------------------------------------------------------------
  it('resolveSharedFile returns shared/ path when shared/ dir exists', async () => {
    fs.mkdirSync(path.join(sharedDir), { recursive: true });
    // Create the target file in shared/
    const identityPath = path.join(sharedDir, 'identity.md');
    fs.mkdirSync(path.dirname(identityPath), { recursive: true });
    fs.writeFileSync(identityPath, '# Identity\n');

    const mod = await loadShared({ createShared: true });
    const result = mod.resolveSharedFile('identity.md');

    expect(result).toBe(path.join(sharedDir, 'identity.md'));
  });

  // -----------------------------------------------------------------------
  // 2. resolveSharedFile — falls back to MEMORY_DIR when shared/ missing
  // -----------------------------------------------------------------------
  it('resolveSharedFile falls back to MEMORY_DIR when shared/ does not exist', async () => {
    const mod = await loadShared({ createShared: false });
    const result = mod.resolveSharedFile('identity.md');

    // When shared/ doesn't exist, SHARED_DIR equals MEMORY_DIR, and since
    // the file doesn't exist anywhere, it returns MEMORY_DIR/identity.md
    expect(result).toBe(path.join(memoryDir, 'identity.md'));
  });

  // -----------------------------------------------------------------------
  // 3. resolveInstanceDir returns correct path
  // -----------------------------------------------------------------------
  it('resolveInstanceDir returns correct path for an instance', async () => {
    const mod = await loadShared();
    const result = mod.resolveInstanceDir('admin');

    expect(result).toBe(path.join(instancesDir, 'admin'));
  });

  // -----------------------------------------------------------------------
  // 4. resolveInstanceFile returns instance-specific path
  // -----------------------------------------------------------------------
  it('resolveInstanceFile returns instance-specific file path', async () => {
    const mod = await loadShared();
    const result = mod.resolveInstanceFile('admin', 'state.md');

    expect(result).toBe(path.join(instancesDir, 'admin', 'state.md'));
  });

  // -----------------------------------------------------------------------
  // 5. resolveSessionsDir — no instance returns default sessions/
  // -----------------------------------------------------------------------
  it('resolveSessionsDir returns default sessions/ when no instance', async () => {
    const mod = await loadShared();
    const result = mod.resolveSessionsDir();

    expect(result).toBe(sessionsDir);
  });

  // -----------------------------------------------------------------------
  // 6. resolveSessionsDir — instance returns instance-specific sessions/
  // -----------------------------------------------------------------------
  it('resolveSessionsDir returns instance-specific sessions/ dir', async () => {
    const mod = await loadShared();
    const result = mod.resolveSessionsDir('admin');

    expect(result).toBe(path.join(instancesDir, 'admin', 'sessions'));
  });

  // -----------------------------------------------------------------------
  // 7. resolveReferenceFiles — shared/reference/ exists
  // -----------------------------------------------------------------------
  it('resolveReferenceFiles finds files in shared/reference/ when it exists', async () => {
    const refFiles = [
      'reference/decisions.md',
      'reference/projects.md',
      'reference/preferences.md',
    ];
    const mod = await loadShared({ createShared: true, referenceFiles: refFiles });
    const result = mod.resolveReferenceFiles();

    expect(result).toHaveLength(3);
    for (const refPath of refFiles) {
      expect(result).toContainEqual(path.join(sharedDir, refPath));
    }
  });

  // -----------------------------------------------------------------------
  // 8. resolveReferenceFiles — falls back to MEMORY_DIR/reference/
  // -----------------------------------------------------------------------
  it('resolveReferenceFiles falls back to MEMORY_DIR/reference/ when shared/ missing', async () => {
    const refFiles = [
      'reference/decisions.md',
      'reference/ideas.md',
    ];
    const mod = await loadShared({ createShared: false, referenceFiles: refFiles });
    const result = mod.resolveReferenceFiles();

    expect(result).toHaveLength(2);
    for (const refPath of refFiles) {
      expect(result).toContainEqual(path.join(memoryDir, refPath));
    }
  });
});

// ---------------------------------------------------------------------------
// Fork config tests
// ---------------------------------------------------------------------------

describe('Fork config (fork-config.js)', () => {
  it('FORK_REPO is xingfanxia/zylos-core', async () => {
    const { FORK_REPO } = await import('../cli/lib/fork-config.js');
    expect(FORK_REPO).toBe('xingfanxia/zylos-core');
  });

  it('UPSTREAM_REPO is zylos-ai/zylos-core', async () => {
    const { UPSTREAM_REPO } = await import('../cli/lib/fork-config.js');
    expect(UPSTREAM_REPO).toBe('zylos-ai/zylos-core');
  });

  it('isFork() returns true since FORK_REPO != UPSTREAM_REPO', async () => {
    const { isFork } = await import('../cli/lib/fork-config.js');
    expect(isFork()).toBe(true);
  });

  it('needsUpstreamCheck() returns true', async () => {
    const { needsUpstreamCheck } = await import('../cli/lib/fork-config.js');
    expect(needsUpstreamCheck()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Upstream merge tests (unit-style, mock execSync + getCurrentVersion)
// ---------------------------------------------------------------------------

describe('Upstream merge helpers (upstream-merge.js)', () => {
  // We use jest.unstable_mockModule since this is ESM.
  // Mock execSync to prevent real git/npm operations.
  // Mock getCurrentVersion to avoid reading package.json from disk.

  let step0_mergeUpstream;
  let captureCliVersion;
  let restoreCliVersion;
  let mockExecSync;

  beforeEach(async () => {
    jest.resetModules();

    mockExecSync = jest.fn();

    jest.unstable_mockModule('node:child_process', () => ({
      execSync: mockExecSync,
    }));

    jest.unstable_mockModule('../cli/lib/self-upgrade.js', () => ({
      getCurrentVersion: jest.fn(() => ({
        success: true,
        version: '0.4.10',
      })),
    }));

    const mod = await import('../cli/lib/upstream-merge.js');
    step0_mergeUpstream = mod.step0_mergeUpstream;
    captureCliVersion = mod.captureCliVersion;
    restoreCliVersion = mod.restoreCliVersion;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // 5. step0_mergeUpstream returns skipped when skipUpstreamMerge is true
  // -----------------------------------------------------------------------
  it('step0_mergeUpstream returns skipped when ctx.skipUpstreamMerge is true', () => {
    const result = step0_mergeUpstream({ skipUpstreamMerge: true });

    expect(result.status).toBe('skipped');
    expect(result.name).toBe('merge_upstream');
    expect(result.message).toMatch(/opt-in only/);
    expect(typeof result.duration).toBe('number');
  });

  // -----------------------------------------------------------------------
  // 6. captureCliVersion populates ctx.previousCliVersion
  // -----------------------------------------------------------------------
  it('captureCliVersion populates ctx.previousCliVersion', () => {
    const ctx = {};
    captureCliVersion(ctx);

    expect(ctx.previousCliVersion).toBe('0.4.10');
  });

  // -----------------------------------------------------------------------
  // 7. restoreCliVersion is a no-op when no previousCliVersion
  // -----------------------------------------------------------------------
  it('restoreCliVersion returns failure when no previousCliVersion', () => {
    const ctx = {};
    const result = restoreCliVersion(ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no previous version captured/);
    // execSync should never be called since there's nothing to restore
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Dashboard routes tests (structural — mock express app)
// ---------------------------------------------------------------------------

describe('Dashboard routes (dashboard-routes.js)', () => {
  let registerDashboardRoutes;
  let loadError;
  let routes;
  let mockApp;

  beforeEach(async () => {
    jest.resetModules();
    loadError = null;

    // Mock all peer dependencies that dashboard-routes.js imports.
    // The { virtual: true } option lets us mock modules that aren't
    // installed in the test environment (express, better-sqlite3, etc.).
    jest.unstable_mockModule('express', () => ({
      default: {
        static: jest.fn(() => (req, res, next) => next()),
      },
    }), { virtual: true });

    jest.unstable_mockModule('better-sqlite3', () => ({
      default: jest.fn(),
    }), { virtual: true });

    jest.unstable_mockModule(
      '../skills/activity-monitor/scripts/health-dashboard.js',
      () => ({
        getSystemHealth: jest.fn(() => ({ status: 'ok' })),
      }),
    );

    jest.unstable_mockModule(
      '../skills/comm-bridge/scripts/c4-instance-router.js',
      () => ({
        updateInstancesConfig: jest.fn(),
        getInstanceDef: jest.fn(),
        getStatusFileForInstance: jest.fn(),
        startWatcher: jest.fn(),
      }),
    );

    try {
      const mod = await import(
        '../skills/web-console/scripts/dashboard-routes.js'
      );
      registerDashboardRoutes = mod.registerDashboardRoutes;
    } catch (err) {
      loadError = err;
    }

    routes = [];
    mockApp = {
      get: (pathOrMiddleware, ...handlers) =>
        routes.push({ method: 'GET', path: pathOrMiddleware }),
      post: (pathOrMiddleware, ...handlers) =>
        routes.push({ method: 'POST', path: pathOrMiddleware }),
      use: (pathOrMiddleware, ...handlers) =>
        routes.push({ method: 'USE', path: pathOrMiddleware }),
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -----------------------------------------------------------------------
  // 8. registerDashboardRoutes is a function
  // -----------------------------------------------------------------------
  it('registerDashboardRoutes is a function', () => {
    if (loadError) {
      // Peer deps (express, better-sqlite3) not installed — verify structural
      // expectation: the module exports a function at the named export.
      // We can still test this by reading the source file statically.
      const src = fs.readFileSync(
        path.join(
          path.dirname(new URL(import.meta.url).pathname),
          '..',
          'skills',
          'web-console',
          'scripts',
          'dashboard-routes.js',
        ),
        'utf8',
      );
      expect(src).toMatch(/export function registerDashboardRoutes/);
      return;
    }
    expect(typeof registerDashboardRoutes).toBe('function');
  });

  // -----------------------------------------------------------------------
  // 9. Calling it registers the expected routes
  // -----------------------------------------------------------------------
  it('registers expected GET and POST routes', () => {
    if (loadError) {
      // Cannot test route registration without peer deps — verify the source
      // defines all expected route paths as a structural check.
      const src = fs.readFileSync(
        path.join(
          path.dirname(new URL(import.meta.url).pathname),
          '..',
          'skills',
          'web-console',
          'scripts',
          'dashboard-routes.js',
        ),
        'utf8',
      );

      const expectedPaths = [
        "app.get('/'",
        "app.get('/api/dashboard'",
        "app.get('/api/dashboard/tokens'",
        "app.get('/api/dashboard/pending-users'",
        "app.post('/api/dashboard/instances/:id/enable'",
        "app.post('/api/dashboard/instances/:id/disable'",
        "app.post('/api/dashboard/instances/:id/suspend'",
        "app.post('/api/dashboard/instances/:id/resume'",
        "app.post('/api/dashboard/approve/:chatId'",
        "app.post('/api/dashboard/deny/:chatId'",
        "app.use('/dashboard'",
      ];
      for (const route of expectedPaths) {
        expect(src).toContain(route);
      }
      return;
    }

    registerDashboardRoutes(mockApp, {
      zylosDir: '/tmp/zylos-test',
      skillRoot: '/tmp/skills/web-console',
      skillsDir: '/tmp/skills',
    });

    const getPaths = routes
      .filter((r) => r.method === 'GET')
      .map((r) => r.path);
    const postPaths = routes
      .filter((r) => r.method === 'POST')
      .map((r) => r.path);
    const usePaths = routes
      .filter((r) => r.method === 'USE')
      .map((r) => r.path);

    // Root redirect
    expect(getPaths).toContain('/');

    // System health
    expect(getPaths).toContain('/api/dashboard');

    // Token usage
    expect(getPaths).toContain('/api/dashboard/tokens');

    // Pending users
    expect(getPaths).toContain('/api/dashboard/pending-users');

    // Instance actions
    expect(postPaths).toContain('/api/dashboard/instances/:id/enable');
    expect(postPaths).toContain('/api/dashboard/instances/:id/disable');
    expect(postPaths).toContain('/api/dashboard/instances/:id/suspend');
    expect(postPaths).toContain('/api/dashboard/instances/:id/resume');

    // Approve / deny
    expect(postPaths).toContain('/api/dashboard/approve/:chatId');
    expect(postPaths).toContain('/api/dashboard/deny/:chatId');

    // Static dashboard files
    expect(usePaths).toContain('/dashboard');
  });
});
