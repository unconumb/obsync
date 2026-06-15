import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildWrapperScript,
  wrapperScriptPath,
  writeWrapperAtomic,
  type WrapperParams,
} from './wrapper';

const baseParams: WrapperParams = {
  nodePath: '/opt/homebrew/bin/node',
  obsyncEntryPath: '/opt/homebrew/lib/node_modules/obsync/dist/cli/index.js',
  configPath: '/Users/testuser/project/obsync.yml',
};

describe('buildWrapperScript', () => {
  it('begins with the #!/bin/bash shebang (not #!/bin/sh)', () => {
    const script = buildWrapperScript(baseParams);
    expect(script.startsWith('#!/bin/bash')).toBe(true);
  });

  it('contains exec -a "Obsync" with double-quoted nodePath/entryPath/configPath', () => {
    const script = buildWrapperScript(baseParams);
    expect(script).toContain(
      `exec -a "Obsync" "${baseParams.nodePath}" "${baseParams.obsyncEntryPath}" watch --config "${baseParams.configPath}"`,
    );
  });

  it('double-quotes every dynamic value (no unquoted interpolation)', () => {
    const script = buildWrapperScript(baseParams);
    expect(script).toContain(`"${baseParams.nodePath}"`);
    expect(script).toContain(`"${baseParams.obsyncEntryPath}"`);
    expect(script).toContain(`"${baseParams.configPath}"`);
  });
});

describe('wrapperScriptPath', () => {
  it('returns ~/.obsync/bin/obsync-watch under the given homeDir', () => {
    expect(wrapperScriptPath('/Users/testuser')).toBe(
      path.join('/Users/testuser', '.obsync', 'bin', 'obsync-watch'),
    );
  });

  it('defaults to os.homedir() when homeDir is not provided', () => {
    expect(wrapperScriptPath()).toBe(path.join(os.homedir(), '.obsync', 'bin', 'obsync-watch'));
  });
});

describe('writeWrapperAtomic', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-wrapper-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the parent directory if it does not exist', () => {
    const scriptPath = path.join(tmpDir, 'nested', 'bin', 'obsync-watch');
    const content = buildWrapperScript(baseParams);

    writeWrapperAtomic(scriptPath, content);

    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(fs.readFileSync(scriptPath, 'utf-8')).toBe(content);
  });

  it('writes the file with executable mode 0o755', () => {
    const scriptPath = path.join(tmpDir, 'obsync-watch');
    const content = buildWrapperScript(baseParams);
    writeWrapperAtomic(scriptPath, content);

    // Platform-independent guarantees: file exists, content matches, no leftover tmp file.
    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(fs.readFileSync(scriptPath, 'utf-8')).toBe(content);
    expect(fs.existsSync(`${scriptPath}.obsync.tmp`)).toBe(false);

    // The Unix executable mode bit is meaningless on NTFS — only assert it on
    // non-Windows platforms where launchd/systemd actually rely on it.
    if (process.platform !== 'win32') {
      const mode = fs.statSync(scriptPath).mode;
      expect(mode & 0o111).toBe(0o111);
      expect(mode & 0o777).toBe(0o755);
    }
  });

  it('does not leave a .obsync.tmp file behind on success', () => {
    const scriptPath = path.join(tmpDir, 'obsync-watch');
    writeWrapperAtomic(scriptPath, buildWrapperScript(baseParams));

    expect(fs.existsSync(`${scriptPath}.obsync.tmp`)).toBe(false);
  });

  it('overwrites an existing wrapper script', () => {
    const scriptPath = path.join(tmpDir, 'obsync-watch');
    writeWrapperAtomic(scriptPath, 'old content');
    writeWrapperAtomic(scriptPath, 'new content');

    expect(fs.readFileSync(scriptPath, 'utf-8')).toBe('new content');
  });
});
