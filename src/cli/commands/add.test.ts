import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runAddFlow } from './add';
import { appendSource, writeConfigAtomic } from '../../config/editor';
import { scanVaultCategories } from '../../onboarding/vault-categories';
import { text, select, confirm, isCancel } from '@clack/prompts';

/**
 * Unit tests for runAddFlow's vault-aware category picker (VCAT-01) and
 * new-category confirmation (VCAT-02).
 *
 * @clack/prompts is mocked so each prompt call returns a queued value
 * without any real TTY interaction. scanVaultCategories is mocked to
 * control which categories are "scanned" vs. not, independent of the
 * real filesystem (08-01 already covers scanVaultCategories itself).
 */

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
  isCancel: vi.fn(() => false),
  cancel: vi.fn(),
}));

vi.mock('../../onboarding/vault-categories', () => ({
  scanVaultCategories: vi.fn(),
}));

vi.mock('../../config/editor', () => ({
  appendSource: vi.fn(() => 'edited-yaml-content'),
  writeConfigAtomic: vi.fn(),
  ConfigEditError: class ConfigEditError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ConfigEditError';
    }
  },
}));

const CONFIG_PATH = 'obsync.yml';
const SOURCE_PATH = '/projects/myproject';
const VAULT_PATH = '/vault';

describe('runAddFlow — vault-scanned category picker (VCAT-01)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isCancel as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
  });

  it('includes a scanned vault subfolder in the picker options', async () => {
    (scanVaultCategories as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
      '02-areas',
      '02-areas/sysadmin',
    ]);

    (text as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('myproject');
    (select as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('02-areas/sysadmin') // category
      .mockResolvedValueOnce('scattered'); // scan mode
    (confirm as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(false); // ai_summary

    await runAddFlow(CONFIG_PATH, SOURCE_PATH, VAULT_PATH);

    expect(scanVaultCategories).toHaveBeenCalledWith(VAULT_PATH);

    const categoryCall = (select as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      options: { value: string; label: string }[];
    };
    const values = categoryCall.options.map((o) => o.value);
    expect(values).toContain('02-areas');
    expect(values).toContain('02-areas/sysadmin');
    expect(values).toContain('__custom__');
  });

  it('selecting an existing scanned category writes the source WITHOUT a new-category confirm', async () => {
    (scanVaultCategories as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
      '02-areas',
      '02-areas/sysadmin',
    ]);

    (text as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('myproject');
    (select as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('02-areas/sysadmin') // category — already scanned
      .mockResolvedValueOnce('scattered'); // scan mode

    // confirm is only used for ai_summary here — return false.
    (confirm as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const result = await runAddFlow(CONFIG_PATH, SOURCE_PATH, VAULT_PATH);

    // Only one confirm call expected: ai_summary. No "Create new category" confirm.
    expect(confirm).toHaveBeenCalledTimes(1);
    const confirmMessages = (confirm as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { message: string }).message,
    );
    expect(confirmMessages.some((m) => m.includes('Create new category'))).toBe(false);

    expect(appendSource).toHaveBeenCalled();
    expect(writeConfigAtomic).toHaveBeenCalled();
    expect(result).toBe('added');
  });

  it('selecting a not-scanned category triggers the confirm and, when confirmed, writes the source', async () => {
    (scanVaultCategories as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
      '02-areas',
      '02-areas/sysadmin',
    ]);

    (text as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('myproject');
    (select as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('02-areas/newteam') // category — NOT in scanned list
      .mockResolvedValueOnce('scattered'); // scan mode

    // First confirm: "Create new category?" -> true. Second confirm: ai_summary -> false.
    (confirm as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const result = await runAddFlow(CONFIG_PATH, SOURCE_PATH, VAULT_PATH);

    const confirmMessages = (confirm as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { message: string }).message,
    );
    expect(confirmMessages.some((m) => m.includes('Create new category "02-areas/newteam"'))).toBe(
      true,
    );

    expect(appendSource).toHaveBeenCalled();
    expect(writeConfigAtomic).toHaveBeenCalled();
    expect(result).toBe('added');
  });

  it('declining the new-category confirm leaves obsync.yml unwritten', async () => {
    (scanVaultCategories as unknown as ReturnType<typeof vi.fn>).mockReturnValue([
      '02-areas',
      '02-areas/sysadmin',
    ]);

    (text as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('myproject');
    (select as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce('02-areas/newteam') // category — NOT in scanned list
      .mockResolvedValueOnce('scattered'); // scan mode

    // "Create new category?" -> false (declined)
    (confirm as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    const result = await runAddFlow(CONFIG_PATH, SOURCE_PATH, VAULT_PATH, false);

    expect(appendSource).not.toHaveBeenCalled();
    expect(writeConfigAtomic).not.toHaveBeenCalled();
    expect(result).toBe('cancelled');
  });
});
