import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildPlistXml,
  escapeXml,
  writePlistAtomic,
  defaultLogPaths,
  ensureLogsDir,
  resolveBinaryPaths,
  type PlistParams,
} from './plist';

const baseParams: PlistParams = {
  label: 'com.obsync.watch',
  nodePath: '/opt/homebrew/bin/node',
  obsyncEntryPath: '/opt/homebrew/lib/node_modules/obsync/dist/cli/index.js',
  configPath: '/Users/testuser/project/obsync.yml',
  workingDir: '/Users/testuser/project',
  stdoutPath: '/Users/testuser/.obsync/logs/watch.out.log',
  stderrPath: '/Users/testuser/.obsync/logs/watch.err.log',
};

describe('escapeXml', () => {
  it('escapes &, <, > characters', () => {
    expect(escapeXml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('escapes & before < and > to avoid double-escaping', () => {
    // If '&' were escaped after '<'/'>', the '&' inside '&lt;'/'&gt;' would
    // itself be re-escaped to '&amp;lt;' — assert this does NOT happen.
    expect(escapeXml('<')).toBe('&lt;');
    expect(escapeXml('>')).toBe('&gt;');
    expect(escapeXml('a & b')).toBe('a &amp; b');
  });

  it('returns strings with no special characters unchanged', () => {
    expect(escapeXml('/Users/testuser/project')).toBe('/Users/testuser/project');
  });
});

describe('buildPlistXml', () => {
  it('begins with the XML + DOCTYPE plist header', () => {
    const xml = buildPlistXml(baseParams);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
    expect(xml).toContain('<plist version="1.0">');
  });

  it('contains the Label key and value', () => {
    const xml = buildPlistXml(baseParams);
    expect(xml).toContain('<key>Label</key>');
    expect(xml).toContain('<string>com.obsync.watch</string>');
  });

  it('contains a ProgramArguments array with node, entry, watch, --config, configPath', () => {
    const xml = buildPlistXml(baseParams);
    expect(xml).toContain('<key>ProgramArguments</key>');
    expect(xml).toContain('<array>');
    expect(xml).toContain(`<string>${baseParams.nodePath}</string>`);
    expect(xml).toContain(`<string>${baseParams.obsyncEntryPath}</string>`);
    expect(xml).toContain('<string>watch</string>');
    expect(xml).toContain('<string>--config</string>');
    expect(xml).toContain(`<string>${baseParams.configPath}</string>`);
  });

  it('contains RunAtLoad=true and KeepAlive=true (D-57)', () => {
    const xml = buildPlistXml(baseParams);
    expect(xml).toContain('<key>RunAtLoad</key>');
    expect(xml).toContain('<key>KeepAlive</key>');
    // both immediately followed by <true/>
    expect(xml).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(xml).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it('contains StandardOutPath and StandardErrorPath (D-60)', () => {
    const xml = buildPlistXml(baseParams);
    expect(xml).toContain('<key>StandardOutPath</key>');
    expect(xml).toContain(`<string>${baseParams.stdoutPath}</string>`);
    expect(xml).toContain('<key>StandardErrorPath</key>');
    expect(xml).toContain(`<string>${baseParams.stderrPath}</string>`);
  });

  it('contains WorkingDirectory', () => {
    const xml = buildPlistXml(baseParams);
    expect(xml).toContain('<key>WorkingDirectory</key>');
    expect(xml).toContain(`<string>${baseParams.workingDir}</string>`);
  });

  it('XML-escapes a configPath containing & (T-05-08)', () => {
    const params: PlistParams = {
      ...baseParams,
      configPath: '/Users/testuser/Dev/R&D/obsync.yml',
    };
    const xml = buildPlistXml(params);
    expect(xml).toContain('<string>/Users/testuser/Dev/R&amp;D/obsync.yml</string>');
    // Raw unescaped '&D' must not appear
    expect(xml).not.toContain('R&D/obsync.yml</string>');
  });

  it('XML-escapes < and > in dynamic values', () => {
    const params: PlistParams = {
      ...baseParams,
      workingDir: '/Users/testuser/<project>',
    };
    const xml = buildPlistXml(params);
    expect(xml).toContain('<string>/Users/testuser/&lt;project&gt;</string>');
  });
});

describe('resolveBinaryPaths', () => {
  it('returns process.execPath as nodePath', () => {
    const { nodePath } = resolveBinaryPaths();
    expect(nodePath).toBe(process.execPath);
  });

  it('returns the realpath of process.argv[1] as obsyncEntryPath', () => {
    const { obsyncEntryPath } = resolveBinaryPaths();
    expect(obsyncEntryPath).toBe(fs.realpathSync(process.argv[1]));
  });
});

describe('writePlistAtomic', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-plist-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the parent directory if it does not exist', () => {
    const plistPath = path.join(tmpDir, 'nested', 'LaunchAgents', 'com.obsync.watch.plist');
    const content = buildPlistXml(baseParams);

    writePlistAtomic(plistPath, content);

    expect(fs.existsSync(plistPath)).toBe(true);
    expect(fs.readFileSync(plistPath, 'utf-8')).toBe(content);
  });

  it('does not leave a .obsync.tmp file behind on success', () => {
    const plistPath = path.join(tmpDir, 'com.obsync.watch.plist');
    writePlistAtomic(plistPath, buildPlistXml(baseParams));

    expect(fs.existsSync(`${plistPath}.obsync.tmp`)).toBe(false);
  });

  it('overwrites an existing plist file', () => {
    const plistPath = path.join(tmpDir, 'com.obsync.watch.plist');
    writePlistAtomic(plistPath, 'old content');
    writePlistAtomic(plistPath, 'new content');

    expect(fs.readFileSync(plistPath, 'utf-8')).toBe('new content');
  });
});

describe('defaultLogPaths', () => {
  it('returns ~/.obsync/logs/watch.out.log and watch.err.log under the given homeDir', () => {
    const { stdout, stderr } = defaultLogPaths('/Users/testuser');

    expect(stdout).toBe(path.join('/Users/testuser', '.obsync', 'logs', 'watch.out.log'));
    expect(stderr).toBe(path.join('/Users/testuser', '.obsync', 'logs', 'watch.err.log'));
  });

  it('defaults to os.homedir() when homeDir is not provided', () => {
    const { stdout } = defaultLogPaths();
    expect(stdout).toBe(path.join(os.homedir(), '.obsync', 'logs', 'watch.out.log'));
  });
});

describe('ensureLogsDir', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-plist-logs-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates ~/.obsync/logs/ recursively', () => {
    ensureLogsDir(tmpDir);

    expect(fs.existsSync(path.join(tmpDir, '.obsync', 'logs'))).toBe(true);
  });

  it('is idempotent — does not throw when the directory already exists', () => {
    ensureLogsDir(tmpDir);
    expect(() => ensureLogsDir(tmpDir)).not.toThrow();
  });
});
