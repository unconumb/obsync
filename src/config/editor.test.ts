import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { appendSource, ConfigEditError, writeConfigAtomic } from './editor';

const FIXTURE_YAML = `# obsync.yml — obsync configuration file
# Created by: obsync init

vault:
  # Absolute path to the Obsidian vault root.
  path: /Users/test/vault

sources:
  # Existing source — has an inline comment that must survive edits.
  - name: existing-source
    path: /Users/test/existing # do not touch this comment
    category: Projects
    scan: scattered
    ai_summary: false
    ignore: []
    labels: []

# Global ignore patterns.
ignore:
  - ".git/"
  - "node_modules/"
`;

const NO_SOURCES_YAML = `vault:
  path: /Users/test/vault
ignore: []
`;

const NEW_SOURCE = {
  name: 'new-source',
  path: '/Users/test/newproj',
  category: 'Personal' as const,
  scan: 'scattered' as const,
  ai_summary: false,
  labels: [],
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-editor-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(content: string): string {
  const configPath = path.join(tmpDir, 'obsync.yml');
  fs.writeFileSync(configPath, content);
  return configPath;
}

describe('appendSource', () => {
  it('preserves existing comments after appending a new source', () => {
    const configPath = writeFixture(FIXTURE_YAML);

    const result = appendSource(configPath, NEW_SOURCE);

    expect(result).toContain('# obsync.yml — obsync configuration file');
    expect(result).toContain('# Existing source — has an inline comment that must survive edits.');
    expect(result).toContain('# do not touch this comment');
    expect(result).toContain('# Global ignore patterns.');
  });

  it('adds the new source under sources: and the result passes ObsyncConfigSchema', () => {
    const configPath = writeFixture(FIXTURE_YAML);

    const result = appendSource(configPath, NEW_SOURCE);
    const reparsed = parseYaml(result);

    expect(reparsed.sources).toHaveLength(2);
    expect(reparsed.sources[1]).toMatchObject({
      name: 'new-source',
      path: '/Users/test/newproj',
      category: 'Personal',
    });
  });

  it('throws ConfigEditError when the input YAML has no sources: sequence', () => {
    const configPath = writeFixture(NO_SOURCES_YAML);

    expect(() => appendSource(configPath, NEW_SOURCE)).toThrow(ConfigEditError);
    expect(() => appendSource(configPath, NEW_SOURCE)).toThrow(/sources/i);
  });

  it('throws ConfigEditError when the new source duplicates an existing name', () => {
    const configPath = writeFixture(FIXTURE_YAML);

    expect(() =>
      appendSource(configPath, { ...NEW_SOURCE, name: 'existing-source' }),
    ).toThrow(ConfigEditError);
  });

  it('throws ConfigEditError when the new source path overlaps the vault path (SEC-09)', () => {
    const configPath = writeFixture(FIXTURE_YAML);

    expect(() =>
      appendSource(configPath, { ...NEW_SOURCE, name: 'inside-vault', path: '/Users/test/vault/sub' }),
    ).toThrow(ConfigEditError);
  });

  it('throws ConfigEditError when vault.path uses ~ and the new source overlaps the expanded path (SEC-09, CR-01)', () => {
    const TILDE_VAULT_YAML = `vault:
  path: ~/vault

sources:
  - name: existing-source
    path: /Users/test/existing
    category: Projects
    scan: scattered
    ai_summary: false
    ignore: []
    labels: []

ignore: []
`;
    const configPath = writeFixture(TILDE_VAULT_YAML);
    const homedir = os.homedir();

    expect(() =>
      appendSource(configPath, {
        ...NEW_SOURCE,
        name: 'inside-tilde-vault',
        path: path.join(homedir, 'vault', 'sub'),
      }),
    ).toThrow(ConfigEditError);
    expect(() =>
      appendSource(configPath, {
        ...NEW_SOURCE,
        name: 'inside-tilde-vault',
        path: path.join(homedir, 'vault', 'sub'),
      }),
    ).toThrow(/SEC-09/);
  });

  it('does not write to disk when validation fails', () => {
    const configPath = writeFixture(FIXTURE_YAML);
    const before = fs.readFileSync(configPath, 'utf-8');

    expect(() =>
      appendSource(configPath, { ...NEW_SOURCE, name: 'existing-source' }),
    ).toThrow(ConfigEditError);

    const after = fs.readFileSync(configPath, 'utf-8');
    expect(after).toBe(before);
  });
});

describe('writeConfigAtomic', () => {
  it('writes content to the target path with 0600 permissions', () => {
    const configPath = path.join(tmpDir, 'obsync.yml');
    fs.writeFileSync(configPath, FIXTURE_YAML, { mode: 0o600 });

    const newContent = appendSource(configPath, NEW_SOURCE);
    writeConfigAtomic(configPath, newContent);

    const written = fs.readFileSync(configPath, 'utf-8');
    expect(written).toBe(newContent);

    if (process.platform !== 'win32') {
      const stat = fs.statSync(configPath);
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('does not leave a .obsync.tmp file behind on success', () => {
    const configPath = path.join(tmpDir, 'obsync.yml');
    fs.writeFileSync(configPath, FIXTURE_YAML, { mode: 0o600 });

    const newContent = appendSource(configPath, NEW_SOURCE);
    writeConfigAtomic(configPath, newContent);

    expect(fs.existsSync(configPath + '.obsync.tmp')).toBe(false);
  });
});
