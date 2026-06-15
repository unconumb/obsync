import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import type { StateFile } from '../../../src/state/types';
import { readState, writeState, getStateDir, getStatePath } from '../../../src/state/store';

// Use OBSYNC_STATE_DIR env var to redirect state to a temp directory.
// This avoids os.homedir() mocking (which is not configurable in CJS modules).
let tmpStateDir: string;

beforeEach(() => {
  tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-state-test-'));
  process.env['OBSYNC_STATE_DIR'] = tmpStateDir;
});

afterEach(() => {
  delete process.env['OBSYNC_STATE_DIR'];
  fs.rmSync(tmpStateDir, { recursive: true, force: true });
});

describe('getStateDir / getStatePath', () => {
  it('getStateDir returns the OBSYNC_STATE_DIR override', () => {
    expect(getStateDir()).toBe(tmpStateDir);
  });

  it('getStatePath returns state.json inside the state dir', () => {
    expect(getStatePath()).toBe(path.join(tmpStateDir, 'state.json'));
  });
});

describe('readState', () => {
  it('returns empty StateFile when state.json does not exist', () => {
    const state = readState();
    expect(state.version).toBe('1');
    expect(state.files).toEqual({});
    expect(typeof state.updatedAt).toBe('string');
  });

  it('creates the state directory if it does not exist', () => {
    // Remove the temp dir so mkdirSync can re-create it
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
    readState();
    expect(fs.existsSync(tmpStateDir)).toBe(true);
  });

  it('deletes orphaned state.json.tmp before reading', () => {
    fs.mkdirSync(tmpStateDir, { recursive: true });
    const tmpPath = path.join(tmpStateDir, 'state.json.tmp');
    fs.writeFileSync(tmpPath, '{"corrupted": true}', 'utf-8');

    readState();

    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it('falls back to state.json.bak when state.json is corrupted', () => {
    fs.mkdirSync(tmpStateDir, { recursive: true });

    const bakState: StateFile = {
      version: '1',
      updatedAt: '2024-01-01T00:00:00.000Z',
      files: {
        'backup-key': {
          hash: 'abc123',
          syncedAt: '2024-01-01T00:00:00.000Z',
          gitRef: null,
          sourceName: 'test-source',
          destinationPath: '/vault/test.md',
        },
      },
    };

    const statePath = path.join(tmpStateDir, 'state.json');
    const bakPath = path.join(tmpStateDir, 'state.json.bak');

    fs.writeFileSync(statePath, 'INVALID JSON{{{{', 'utf-8');
    fs.writeFileSync(bakPath, JSON.stringify(bakState), 'utf-8');

    const result = readState();

    expect(result.files['backup-key']).toBeDefined();
    expect(result.files['backup-key'].hash).toBe('abc123');
  });

  it('returns empty StateFile when both state.json and bak are corrupted', () => {
    fs.mkdirSync(tmpStateDir, { recursive: true });

    const statePath = path.join(tmpStateDir, 'state.json');
    const bakPath = path.join(tmpStateDir, 'state.json.bak');

    fs.writeFileSync(statePath, 'NOT JSON', 'utf-8');
    fs.writeFileSync(bakPath, 'ALSO NOT JSON', 'utf-8');

    const result = readState();

    expect(result.version).toBe('1');
    expect(result.files).toEqual({});
  });
});

describe('writeState', () => {
  const sampleState: StateFile = {
    version: '1',
    updatedAt: '2024-06-01T12:00:00.000Z',
    files: {
      'source/README.md': {
        hash: 'deadbeef',
        syncedAt: '2024-06-01T12:00:00.000Z',
        gitRef: 'abc123',
        sourceName: 'my-source',
        destinationPath: '/vault/docs/my-source/README.md',
      },
    },
  };

  it('writeState then readState returns the same data', () => {
    writeState(sampleState);
    const result = readState();

    expect(result.version).toBe('1');
    expect(result.updatedAt).toBe(sampleState.updatedAt);
    expect(result.files['source/README.md'].hash).toBe('deadbeef');
    expect(result.files['source/README.md'].gitRef).toBe('abc123');
  });

  it('creates state.json.bak from the prior state.json on second write', () => {
    const firstState: StateFile = {
      version: '1',
      updatedAt: '2024-01-01T00:00:00.000Z',
      files: {},
    };
    writeState(firstState);
    writeState(sampleState);

    const bakPath = path.join(tmpStateDir, 'state.json.bak');
    expect(fs.existsSync(bakPath)).toBe(true);

    const bakContent = JSON.parse(fs.readFileSync(bakPath, 'utf-8')) as StateFile;
    expect(bakContent.updatedAt).toBe('2024-01-01T00:00:00.000Z');
  });

  it('uses renameSync for atomic write (state.json.tmp is gone after write)', () => {
    writeState(sampleState);
    const tmpPath = path.join(tmpStateDir, 'state.json.tmp');
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it('state.json exists after writeState', () => {
    writeState(sampleState);
    const statePath = path.join(tmpStateDir, 'state.json');
    expect(fs.existsSync(statePath)).toBe(true);
  });
});
