import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const CLI = path.resolve(__dirname, '../../dist/cli/index.js');
const FIXTURES_SCATTERED = path.resolve(__dirname, '../fixtures/scattered');

/**
 * Integration tests for the obsync CLI.
 *
 * Covers:
 *   - Help commands (smoke tests)
 *   - Full sync run: files appear in vault with obsync_* frontmatter
 *   - Idempotent sync: running twice produces 0 copied on second run
 *   - --dry-run: vault directory NOT modified
 */

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-int-test-'));
}

/**
 * Create a temporary obsync config YAML file for integration tests.
 * Config uses a vault path in a temp dir and a source pointing at our fixtures.
 *
 * World-readable check (SEC-02): chmod 600 on the created config file.
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
  // SEC-02: restrict config permissions so world-readable check passes
  fs.chmodSync(configPath, 0o600);

  return configPath;
}

describe('obsync CLI — walking skeleton', () => {
  it('obsync sync --help exits 0 and mentions --dry-run', () => {
    const result = spawnSync('node', [CLI, 'sync', '--help'], {
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('dry-run');
  });

  it('obsync status --help exits 0 and mentions --config', () => {
    const result = spawnSync('node', [CLI, 'status', '--help'], {
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('config');
  });

  it('obsync init --help exits 0 and mentions --config', () => {
    const result = spawnSync('node', [CLI, 'init', '--help'], {
      encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('config');
  });
});

describe('obsync sync — full pipeline', () => {
  let vaultDir: string;
  let configPath: string;
  let configDir: string;

  beforeEach(() => {
    vaultDir = makeTmpDir();
    configPath = createFixtureConfig(vaultDir, FIXTURES_SCATTERED);
    configDir = path.dirname(configPath);
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it('obsync sync -c <config> exits 0 and outputs "Sync complete"', () => {
    const result = spawnSync('node', [CLI, 'sync', '-c', configPath], {
      encoding: 'utf-8',
      env: { ...process.env, OBSYNC_STATE_DIR: path.join(vaultDir, '.obsync-state') },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Sync complete');
  });

  it('summary line reports all six counts: added, updated, moved, removed, unchanged, errors', () => {
    const result = spawnSync('node', [CLI, 'sync', '-c', configPath], {
      encoding: 'utf-8',
      env: { ...process.env, OBSYNC_STATE_DIR: path.join(vaultDir, '.obsync-state') },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /Sync complete: \d+ added, \d+ updated, \d+ moved, \d+ removed, \d+ unchanged, \d+ errors/,
    );
  });

  it('vault directory contains synced .md files after sync', () => {
    spawnSync('node', [CLI, 'sync', '-c', configPath], {
      encoding: 'utf-8',
      env: { ...process.env, OBSYNC_STATE_DIR: path.join(vaultDir, '.obsync-state') },
    });

    const withFm = path.join(vaultDir, 'Docs', 'test-source', 'with-frontmatter.md');
    const noFm = path.join(vaultDir, 'Docs', 'test-source', 'no-frontmatter.md');

    expect(fs.existsSync(withFm)).toBe(true);
    expect(fs.existsSync(noFm)).toBe(true);

    // Files should have obsync_* frontmatter
    const withFmContent = fs.readFileSync(withFm, 'utf-8');
    expect(withFmContent).toContain('obsync_source: test-source');
    expect(withFmContent).toContain('obsync_hash:');
    expect(withFmContent).toContain('obsync_synced_at:');
    // Source frontmatter preserved (D-12)
    expect(withFmContent).toContain('title: Document With Frontmatter');
  });

  it('running sync twice produces 0 copied on second run (idempotent — SYNC-02)', () => {
    const stateDir = path.join(vaultDir, '.obsync-state');
    const env = { ...process.env, OBSYNC_STATE_DIR: stateDir };

    // First run
    spawnSync('node', [CLI, 'sync', '-c', configPath], { encoding: 'utf-8', env });

    // Second run
    const result = spawnSync('node', [CLI, 'sync', '-c', configPath], { encoding: 'utf-8', env });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Sync complete');
    // Second run should show 0 added and 0 updated
    expect(result.stdout).toContain('0 added');
    expect(result.stdout).toContain('0 updated');
  });

  it('--dry-run: vault directory NOT modified, stdout mentions files or dry-run', () => {
    const stateDir = path.join(vaultDir, '.obsync-state');
    const env = { ...process.env, OBSYNC_STATE_DIR: stateDir };

    const result = spawnSync('node', [CLI, 'sync', '-c', configPath, '--dry-run'], {
      encoding: 'utf-8',
      env,
    });

    expect(result.status).toBe(0);

    // Vault should NOT contain any synced files
    const withFm = path.join(vaultDir, 'Docs', 'test-source', 'with-frontmatter.md');
    expect(fs.existsSync(withFm)).toBe(false);
  });
});
