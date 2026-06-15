import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Integration tests for `obsync status` command.
 *
 * Uses real tmp dirs, real config files, and the built CLI binary.
 * Covers:
 *   - Before any sync: exits 0, stdout contains "No sync history"
 *   - After running sync: exits 0, stdout contains "Last sync:" and "up to date"
 *   - Invalid config: exits 1 with error message
 */

const CLI = path.resolve(__dirname, '../../dist/cli/index.js');
const FIXTURES_SCATTERED = path.resolve(__dirname, '../fixtures/scattered');

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-status-test-'));
}

/**
 * Create a temporary obsync config YAML file.
 * chmod 600 — required by SEC-02 world-readable check in loadConfig.
 */
function createFixtureConfig(vaultPath: string, sourcePath: string): string {
  const tmpDir = makeTmpDir();
  const configPath = path.join(tmpDir, 'obsync-test.yml');

  const yaml = [
    `vault:`,
    `  path: '${vaultPath}'`,
    `sources:`,
    `  - name: test-source`,
    `    path: '${sourcePath}'`,
    `    category: Docs`,
    `    scan: scattered`,
    `    ai_summary: false`,
    `    ignore: []`,
    `    labels: []`,
    `ignore: []`,
    `audit_log: '${path.join(tmpDir, 'audit.log')}'`,
  ].join('\n');

  fs.writeFileSync(configPath, yaml, 'utf-8');
  fs.chmodSync(configPath, 0o600);

  return configPath;
}

describe('obsync status — integration tests', () => {
  let vaultDir: string;
  let configPath: string;
  let configDir: string;
  let stateDir: string;

  beforeEach(() => {
    vaultDir = makeTmpDir();
    stateDir = path.join(makeTmpDir(), '.obsync-state');
    configPath = createFixtureConfig(vaultDir, FIXTURES_SCATTERED);
    configDir = path.dirname(configPath);
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(stateDir), { recursive: true, force: true });
  });

  it('before any sync: exits 0 and stdout contains "No sync history"', () => {
    const result = spawnSync('node', [CLI, 'status', '-c', configPath], {
      encoding: 'utf-8',
      env: { ...process.env, OBSYNC_STATE_DIR: stateDir },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No sync history');
  });

  it('after running sync: exits 0, stdout contains "Last sync:" and "up to date"', () => {
    const env = { ...process.env, OBSYNC_STATE_DIR: stateDir };

    // Run sync first to populate state
    const syncResult = spawnSync('node', [CLI, 'sync', '-c', configPath], {
      encoding: 'utf-8',
      env,
    });
    expect(syncResult.status).toBe(0);

    // Now run status
    const statusResult = spawnSync('node', [CLI, 'status', '-c', configPath], {
      encoding: 'utf-8',
      env,
    });

    expect(statusResult.status).toBe(0);
    expect(statusResult.stdout).toContain('Last sync:');
    expect(statusResult.stdout).toContain('up to date');
  });

  it('invalid config path: exits 1 with error message on stderr', () => {
    const result = spawnSync('node', [CLI, 'status', '-c', '/nonexistent/path.yml'], {
      encoding: 'utf-8',
      env: { ...process.env, OBSYNC_STATE_DIR: stateDir },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toBeTruthy();
  });
});
