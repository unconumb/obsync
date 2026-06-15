import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initConfig, OBSYNC_YML_TEMPLATE } from '../../../src/config/init';

describe('initConfig', () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates obsync.yml at the given path with content matching OBSYNC_YML_TEMPLATE', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-init-test-'));
    const configPath = path.join(tmpDir, 'obsync.yml');

    initConfig(configPath, tmpDir);

    expect(fs.existsSync(configPath)).toBe(true);
    const content = fs.readFileSync(configPath, 'utf-8');
    expect(content).toBe(OBSYNC_YML_TEMPLATE);
  });

  it('creates obsync.yml with permissions 0o600 on POSIX', () => {
    if (process.platform === 'win32') return; // chmod is a no-op on Windows

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-init-test-'));
    const configPath = path.join(tmpDir, 'obsync.yml');

    initConfig(configPath, tmpDir);

    const stat = fs.statSync(configPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('appends .env to .gitignore when .gitignore exists but does not contain .env', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-init-test-'));
    const configPath = path.join(tmpDir, 'obsync.yml');
    const gitignorePath = path.join(tmpDir, '.gitignore');
    fs.writeFileSync(gitignorePath, 'node_modules/\ndist/\n');

    initConfig(configPath, tmpDir);

    const content = fs.readFileSync(gitignorePath, 'utf-8');
    const lines = content.split('\n').map((l) => l.trim());
    expect(lines).toContain('.env');
  });

  it('does NOT duplicate .env if .gitignore already contains a .env line', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-init-test-'));
    const configPath = path.join(tmpDir, 'obsync.yml');
    const gitignorePath = path.join(tmpDir, '.gitignore');
    fs.writeFileSync(gitignorePath, 'node_modules/\n.env\ndist/\n');

    initConfig(configPath, tmpDir);

    const content = fs.readFileSync(gitignorePath, 'utf-8');
    const envLines = content.split('\n').filter((l) => l.trim() === '.env');
    expect(envLines).toHaveLength(1);
  });

  it('throws when obsync.yml already exists at the target path', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-init-test-'));
    const configPath = path.join(tmpDir, 'obsync.yml');
    fs.writeFileSync(configPath, '# existing config');

    expect(() => initConfig(configPath, tmpDir)).toThrowError(/already exists/);
  });

  it('prints note about missing .gitignore when .gitignore does not exist in cwd', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-init-test-'));
    const configPath = path.join(tmpDir, 'obsync.yml');
    // No .gitignore in tmpDir

    const chunks: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });

    try {
      initConfig(configPath, tmpDir);
    } finally {
      vi.restoreAllMocks();
    }

    const hasNote = chunks.some((c) => c.includes('no .gitignore found'));
    expect(hasNote).toBe(true);
  });
});
