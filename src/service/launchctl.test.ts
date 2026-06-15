import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'child_process';
import {
  getServiceStatus,
  bootstrapService,
  bootoutService,
  installService,
  uninstallService,
} from './launchctl';

type ExecFn = typeof execFileSync;

const LABEL = 'com.obsync.watch';
const UID = 501;
const PLIST_PATH = '/Users/testuser/Library/LaunchAgents/com.obsync.watch.plist';

describe('getServiceStatus', () => {
  it('returns "not-loaded" when execFn throws (launchctl print non-zero exit)', () => {
    const execFn = vi.fn(() => {
      throw new Error('Could not find service');
    }) as unknown as ExecFn;

    expect(getServiceStatus(LABEL, UID, execFn)).toBe('not-loaded');
  });

  it('returns "running" when output contains "state = running"', () => {
    const execFn = vi.fn(
      () => 'PID = 1234\nstate = running\n',
    ) as unknown as ExecFn;

    expect(getServiceStatus(LABEL, UID, execFn)).toBe('running');
  });

  it('returns "loaded-not-running" when output does not contain "state = running"', () => {
    const execFn = vi.fn(() => 'PID = -\nstate = waiting\n') as unknown as ExecFn;

    expect(getServiceStatus(LABEL, UID, execFn)).toBe('loaded-not-running');
  });

  it('calls execFn with launchctl print gui/<uid>/<label>', () => {
    const execFn = vi.fn(() => 'state = running\n') as unknown as ExecFn;

    getServiceStatus(LABEL, UID, execFn);

    expect(execFn).toHaveBeenCalledWith(
      'launchctl',
      ['print', `gui/${UID}/${LABEL}`],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });
});

describe('bootstrapService', () => {
  it('calls execFn with launchctl bootstrap gui/<uid> <plistPath>', () => {
    const execFn = vi.fn(() => '') as unknown as ExecFn;

    bootstrapService(UID, PLIST_PATH, execFn);

    expect(execFn).toHaveBeenCalledWith(
      'launchctl',
      ['bootstrap', `gui/${UID}`, PLIST_PATH],
      expect.any(Object),
    );
  });
});

describe('bootoutService', () => {
  it('calls execFn with launchctl bootout gui/<uid>/<label>', () => {
    const execFn = vi.fn(() => '') as unknown as ExecFn;

    bootoutService(UID, LABEL, execFn);

    expect(execFn).toHaveBeenCalledWith(
      'launchctl',
      ['bootout', `gui/${UID}/${LABEL}`],
      expect.any(Object),
    );
  });
});

describe('installService', () => {
  it('calls bootout FIRST then bootstrap (idempotent, Pitfall 3)', () => {
    const calls: string[][] = [];
    const execFn = vi.fn((cmd: string, args: readonly string[]) => {
      calls.push([cmd, ...args]);
      return '';
    }) as unknown as ExecFn;

    installService(UID, LABEL, PLIST_PATH, execFn);

    expect(calls).toEqual([
      ['launchctl', 'bootout', `gui/${UID}/${LABEL}`],
      ['launchctl', 'bootstrap', `gui/${UID}`, PLIST_PATH],
    ]);
  });

  it('swallows a bootout error and still calls bootstrap', () => {
    const execFn = vi.fn((cmd: string, args: readonly string[]) => {
      if (args[0] === 'bootout') {
        throw new Error('Could not find service "com.obsync.watch" in domain for UID 501: 3: No such process');
      }
      return '';
    }) as unknown as ExecFn;

    expect(() => installService(UID, LABEL, PLIST_PATH, execFn)).not.toThrow();
    expect(execFn).toHaveBeenCalledWith(
      'launchctl',
      ['bootstrap', `gui/${UID}`, PLIST_PATH],
      expect.any(Object),
    );
  });

  it('propagates a bootstrap error after exhausting retries', () => {
    const execFn = vi.fn((cmd: string, args: readonly string[]) => {
      if (args[0] === 'bootstrap') {
        throw new Error('Bootstrap failed: 5: Input/output error');
      }
      return '';
    }) as unknown as ExecFn;

    expect(() => installService(UID, LABEL, PLIST_PATH, execFn)).toThrow(/Bootstrap failed/);
    const bootstrapCalls = (execFn as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (call) => (call[1] as readonly string[])[0] === 'bootstrap',
    );
    expect(bootstrapCalls).toHaveLength(3);
  });

  it('retries bootstrap after a transient "Input/output error" and succeeds (live-verified race, Plan 05)', () => {
    let bootstrapAttempts = 0;
    const execFn = vi.fn((cmd: string, args: readonly string[]) => {
      if (args[0] === 'bootstrap') {
        bootstrapAttempts += 1;
        if (bootstrapAttempts < 2) {
          throw new Error('Bootstrap failed: 5: Input/output error');
        }
      }
      return '';
    }) as unknown as ExecFn;

    expect(() => installService(UID, LABEL, PLIST_PATH, execFn)).not.toThrow();
    expect(bootstrapAttempts).toBe(2);
    expect(execFn).toHaveBeenCalledWith('sleep', ['0.5'], expect.any(Object));
  });
});

describe('uninstallService', () => {
  it('calls bootout with launchctl bootout gui/<uid>/<label>', () => {
    const execFn = vi.fn(() => '') as unknown as ExecFn;

    uninstallService(UID, LABEL, execFn);

    expect(execFn).toHaveBeenCalledWith(
      'launchctl',
      ['bootout', `gui/${UID}/${LABEL}`],
      expect.any(Object),
    );
  });
});

describe('argv-array invocation (T-05-10 — no shell interpolation)', () => {
  it('never receives a shell-string command containing spaces as a single argv element', () => {
    const mockFn = vi.fn(() => 'state = running\n');
    const execFn = mockFn as unknown as ExecFn;

    getServiceStatus(LABEL, UID, execFn);
    bootstrapService(UID, PLIST_PATH, execFn);
    bootoutService(UID, LABEL, execFn);

    for (const call of mockFn.mock.calls) {
      const [cmd, args] = call as unknown as [string, string[]];
      expect(cmd).toBe('launchctl');
      expect(Array.isArray(args)).toBe(true);
      // 'launchctl' itself must never be invoked via a shell wrapper like 'sh -c'
      expect(cmd).not.toMatch(/[;&|]/);
    }
  });
});
