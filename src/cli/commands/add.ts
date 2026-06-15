import { Command } from 'commander';
import * as path from 'path';
import { intro, outro, text, select, confirm, isCancel, cancel } from '@clack/prompts';
import { loadConfig, ConfigLoadError } from '../../config/loader';
import { appendSource, writeConfigAtomic, ConfigEditError, NewSourceInput } from '../../config/editor';
import { inferCategory, detectName, detectScan } from '../../onboarding/detect';
import { scanVaultCategories } from '../../onboarding/vault-categories';
import { expandHome } from '../../utils/paths';

/**
 * runAddFlow — interactive add-confirm flow for a single source path (D-61..D-64).
 *
 * Shared between `obsync add` (Task 1) and `obsync discover` (Task 2, per
 * selected candidate). Prompts the user to confirm/override auto-detected
 * defaults (name, category, scan mode, ai_summary), then appends the new
 * source to obsync.yml via appendSource + writeConfigAtomic.
 *
 * Cancel sentinel (Ctrl-C) at any prompt: prints a cancellation message and
 * exits the process with code 0, leaving obsync.yml untouched (T-05-07).
 *
 * Validation failures (ConfigEditError — duplicate name, SEC-09 overlap,
 * schema errors) are printed to stderr WITHOUT writing to disk (T-05-03).
 *
 * @param configPath - Path to obsync.yml (e.g. options.config).
 * @param sourcePath - Resolved absolute path of the candidate source.
 * @param vaultPath - Absolute path to the vault root (config.vault.path),
 *   used to scan for vault-aware category picker options (VCAT-01).
 * @param exitOnCancel - If true (default), Ctrl-C calls process.exit(0). If
 *   false, returns 'cancelled' so callers (e.g. discover) can continue with
 *   the next candidate instead of exiting the whole process.
 * @returns 'added' | 'cancelled' | 'error'
 */
export async function runAddFlow(
  configPath: string,
  sourcePath: string,
  vaultPath: string,
  exitOnCancel = true,
): Promise<'added' | 'cancelled' | 'error'> {
  const detectedName = detectName(sourcePath);
  const detectedCategory = inferCategory(sourcePath);
  const detectedScan = detectScan(sourcePath);

  const handleCancel = (): 'cancelled' => {
    cancel('Aborted. obsync.yml unchanged.');
    if (exitOnCancel) {
      process.exit(0);
    }
    return 'cancelled';
  };

  const name = await text({
    message: 'Source name',
    initialValue: detectedName,
  });
  if (isCancel(name)) {
    return handleCancel();
  }

  const CUSTOM_CATEGORY = '__custom__';

  const scanned = scanVaultCategories(vaultPath);

  const categoryChoice = await select({
    message: 'Category',
    options: [
      ...scanned.map((s) => ({ value: s, label: s })),
      { value: CUSTOM_CATEGORY, label: 'Other (type your own)' },
    ],
    initialValue: detectedCategory,
  });
  if (isCancel(categoryChoice)) {
    return handleCancel();
  }

  let category = categoryChoice;
  if (categoryChoice === CUSTOM_CATEGORY) {
    const customCategory = await text({
      message: 'Custom category (vault folder name)',
      validate: (value) => {
        const v = (value ?? '').trim();
        if (v.length === 0) return 'Category cannot be empty';
        if (v.startsWith('/') || v.split('/').some((seg) => seg === '..')) {
          return 'Category cannot contain ".." or be an absolute path';
        }
        return undefined;
      },
    });
    if (isCancel(customCategory)) {
      return handleCancel();
    }
    category = customCategory;
  }

  // VCAT-02 (D-05): any category not present in the vault scan — whether a
  // freeform 'Other' value or a picked value the scan didn't surface (e.g. a
  // brand-new nested subarea) — requires an explicit confirmation before the
  // source is written. Existing scanned categories never prompt here.
  if (!scanned.includes(category)) {
    const createNewCategory = await confirm({
      message: `Create new category "${category}"?`,
      initialValue: false,
    });
    if (isCancel(createNewCategory)) {
      return handleCancel();
    }
    if (!createNewCategory) {
      return handleCancel();
    }
  }

  const scan = await select<'scattered' | 'docs'>({
    message: 'Scan mode',
    options: [
      { value: 'scattered', label: 'scattered (loose .md files)' },
      { value: 'docs', label: 'docs (dedicated docs/ or .planning/ folder)' },
    ],
    initialValue: detectedScan,
  });
  if (isCancel(scan)) {
    return handleCancel();
  }

  const aiSummary = await confirm({
    message: 'Enable AI summarization for this source?',
    initialValue: false,
  });
  if (isCancel(aiSummary)) {
    return handleCancel();
  }

  const newSource: NewSourceInput = {
    name,
    path: sourcePath,
    category,
    scan,
    ai_summary: aiSummary,
    labels: [],
  };

  let edited: string;
  try {
    edited = appendSource(configPath, newSource);
  } catch (err) {
    if (err instanceof ConfigEditError) {
      process.stderr.write(`Error: ${err.message}\n`);
      return 'error';
    }
    throw err;
  }

  writeConfigAtomic(configPath, edited);
  process.stdout.write(`Added source "${name}" to ${configPath}.\n`);
  return 'added';
}

/**
 * buildAddCommand — `obsync add <path>` (D-61..D-64).
 *
 * Auto-detects defaults for a new source folder, prompts the user to
 * confirm/override each field, and appends the new source into obsync.yml
 * on confirm via the comment-preserving editor (Plan 02).
 */
export function buildAddCommand(): Command {
  const cmd = new Command('add');

  cmd
    .description('Interactively add a new source folder to obsync.yml')
    .argument('<path>', 'Path to the source folder to add')
    .option('-c, --config <path>', 'Path to obsync.yml', 'obsync.yml')
    .action(async (sourcePathArg: string, options: { config: string }) => {
      let config: ReturnType<typeof loadConfig>;
      try {
        config = loadConfig(options.config);
      } catch (err) {
        if (err instanceof ConfigLoadError) {
          process.stderr.write(`obsync: config error: ${err.message}\n`);
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(`obsync: unexpected error loading config: ${msg}\n`);
        }
        process.exit(1);
        return;
      }

      const resolvedPath = path.resolve(expandHome(sourcePathArg));

      intro(`obsync add ${resolvedPath}`);

      const result = await runAddFlow(options.config, resolvedPath, config.vault.path, true);

      if (result === 'error') {
        process.exit(1);
        return;
      }

      outro('Done.');
    });

  return cmd;
}
