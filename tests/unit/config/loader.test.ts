import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, ConfigLoadError } from '../../../src/config/loader';

// Helper: build a minimal valid YAML config string
function makeValidYaml(vaultPath: string, sourcePath: string): string {
  return [
    `vault:`,
    `  path: ${vaultPath}`,
    `sources:`,
    `  - name: test-source`,
    `    path: ${sourcePath}`,
    `    category: Projects`,
  ].join('\n');
}

describe('loadConfig', () => {
  let tmpDir: string;

  afterEach(() => {
    // Clean up any temp dir created in tests
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  it('returns ObsyncConfig for a valid config file with correct permissions', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-test-'));
    const vaultPath = path.join(tmpDir, 'vault');
    const sourcePath = path.join(tmpDir, 'source');
    fs.mkdirSync(vaultPath, { recursive: true });
    fs.mkdirSync(sourcePath, { recursive: true });
    const configPath = path.join(tmpDir, 'obsync.yml');
    fs.writeFileSync(configPath, makeValidYaml(vaultPath, sourcePath));
    fs.chmodSync(configPath, 0o600);

    const config = loadConfig(configPath);

    expect(config.vault.path).toBe(vaultPath);
    expect(config.sources).toHaveLength(1);
    expect(config.sources[0].name).toBe('test-source');
  });

  it('throws ConfigLoadError containing "world-readable" for chmod 0o644 config', () => {
    if (process.platform === 'win32') return; // Permission checks are no-ops on Windows
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-test-'));
    const vaultPath = path.join(tmpDir, 'vault');
    const sourcePath = path.join(tmpDir, 'source');
    fs.mkdirSync(vaultPath, { recursive: true });
    fs.mkdirSync(sourcePath, { recursive: true });
    const configPath = path.join(tmpDir, 'obsync.yml');
    fs.writeFileSync(configPath, makeValidYaml(vaultPath, sourcePath));
    fs.chmodSync(configPath, 0o644);

    expect(() => loadConfig(configPath)).toThrowError(ConfigLoadError);
    expect(() => loadConfig(configPath)).toThrowError(/world-readable/);
  });

  it('throws ConfigLoadError containing "hardcoded API key" for config with sk- pattern', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-test-'));
    const vaultPath = path.join(tmpDir, 'vault');
    const sourcePath = path.join(tmpDir, 'source');
    fs.mkdirSync(vaultPath, { recursive: true });
    fs.mkdirSync(sourcePath, { recursive: true });
    const configPath = path.join(tmpDir, 'obsync.yml');
    const yamlWithKey =
      makeValidYaml(vaultPath, sourcePath) + '\n# api_key: sk-abcdefghij1234567890\n';
    fs.writeFileSync(configPath, yamlWithKey);
    fs.chmodSync(configPath, 0o600);

    expect(() => loadConfig(configPath)).toThrowError(ConfigLoadError);
    expect(() => loadConfig(configPath)).toThrowError(/hardcoded API key/);
  });

  it('throws ConfigLoadError containing "parse" for malformed YAML', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-test-'));
    const configPath = path.join(tmpDir, 'obsync.yml');
    fs.writeFileSync(configPath, 'vault:\n  path: /vault\n  bad: [unclosed bracket\n');
    fs.chmodSync(configPath, 0o600);

    expect(() => loadConfig(configPath)).toThrowError(ConfigLoadError);
    expect(() => loadConfig(configPath)).toThrowError(/parse/i);
  });

  it('throws ConfigLoadError containing "[vault.path]" for config missing vault.path', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-test-'));
    const configPath = path.join(tmpDir, 'obsync.yml');
    const yaml = [
      'vault: {}',
      'sources:',
      '  - name: src',
      '    path: /home/user/src',
      '    category: Projects',
    ].join('\n');
    fs.writeFileSync(configPath, yaml);
    fs.chmodSync(configPath, 0o600);

    expect(() => loadConfig(configPath)).toThrowError(ConfigLoadError);
    expect(() => loadConfig(configPath)).toThrowError(/\[vault\.path\]/);
  });

  it('throws ConfigLoadError containing "overlap" when source path is inside vault path', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-test-'));
    const vaultPath = path.join(tmpDir, 'vault');
    const sourcePath = path.join(vaultPath, 'nested-source'); // inside vault!
    fs.mkdirSync(vaultPath, { recursive: true });
    fs.mkdirSync(sourcePath, { recursive: true });
    const configPath = path.join(tmpDir, 'obsync.yml');
    fs.writeFileSync(configPath, makeValidYaml(vaultPath, sourcePath));
    fs.chmodSync(configPath, 0o600);

    expect(() => loadConfig(configPath)).toThrowError(ConfigLoadError);
    expect(() => loadConfig(configPath)).toThrowError(/overlap/i);
  });

  it('expands ~ in source path to an absolute path (no ~ in result)', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-test-'));
    const vaultPath = path.join(tmpDir, 'vault');
    fs.mkdirSync(vaultPath, { recursive: true });
    const configPath = path.join(tmpDir, 'obsync.yml');
    // Use ~/obsync-test-tilde-source as the source path — it won't exist on disk
    // but path expansion is tested before any fs operation on the source
    const yaml = [
      `vault:`,
      `  path: ${vaultPath}`,
      `sources:`,
      `  - name: tilde-source`,
      `    path: ~/obsync-test-tilde-source`,
      `    category: Projects`,
    ].join('\n');
    fs.writeFileSync(configPath, yaml);
    fs.chmodSync(configPath, 0o600);

    const config = loadConfig(configPath);

    expect(config.sources[0].path).not.toContain('~');
    expect(config.sources[0].path).toBe(
      path.resolve(path.join(os.homedir(), 'obsync-test-tilde-source'))
    );
  });

  it.skipIf(process.platform === 'win32')(
    'throws ConfigLoadError containing "root" when process.getuid returns 0',
    () => {
    // Mock process.getuid to simulate running as root (POSIX-only API)
    vi.spyOn(process, 'getuid' as never).mockReturnValue(0 as unknown as () => number);

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-test-'));
    const configPath = path.join(tmpDir, 'obsync.yml');
    fs.writeFileSync(configPath, 'vault:\n  path: /vault\n');
    fs.chmodSync(configPath, 0o600);

    expect(() => loadConfig(configPath)).toThrowError(ConfigLoadError);
    expect(() => loadConfig(configPath)).toThrowError(/root/i);
    },
  );
});
