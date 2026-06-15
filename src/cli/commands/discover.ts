import { Command } from 'commander';
import * as path from 'path';
import { intro, outro, multiselect, isCancel, cancel, log } from '@clack/prompts';
import { loadConfig, ConfigLoadError } from '../../config/loader';
import { discoverCandidates } from '../../onboarding/discover';
import { inferCategory, detectName, detectScan } from '../../onboarding/detect';
import { runAddFlow } from './add';
import { expandHome } from '../../utils/paths';

/**
 * buildDiscoverCommand — `obsync discover <root>` (D-65/D-66).
 *
 * Scans the immediate subdirectories of <root> for viable source candidates
 * (discoverCandidates, Plan 02), presents a multi-select annotated with each
 * candidate's auto-detected name/category/scan mode, and runs the shared
 * add-confirm flow (runAddFlow, Task 1) for each selected candidate.
 *
 * Per-candidate ConfigEditError failures are printed and skipped — discover
 * continues with the next candidate rather than aborting the whole run.
 *
 * Pitfall 5 (05-RESEARCH.md): <root> should be the PARENT of the project
 * folders you want as separate sources (e.g. `obsync discover ~/Dev/Personal`,
 * not `obsync discover ~/Dev` or `obsync discover ~`) — documented in
 * .description() and the zero-candidates message below.
 */
export function buildDiscoverCommand(): Command {
  const cmd = new Command('discover');

  cmd
    .description(
      'Scan <root> for candidate source folders and interactively add selected ones. ' +
        '<root> should be the PARENT of the project folders you want as separate sources ' +
        '(e.g. "obsync discover ~/Dev/Personal", not "obsync discover ~/Dev" or "obsync discover ~").',
    )
    .argument('<root>', 'Parent directory to scan for candidate source folders')
    .option('-c, --config <path>', 'Path to obsync.yml', 'obsync.yml')
    .action(async (rootArg: string, options: { config: string }) => {
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

      const resolvedRoot = path.resolve(expandHome(rootArg));
      const existingSourcePaths = config.sources.map((s) => s.path);

      const candidates = discoverCandidates(resolvedRoot, existingSourcePaths, config.ignore);

      if (candidates.length === 0) {
        process.stdout.write(
          `No candidate source folders found under ${resolvedRoot}.\n` +
            'Tip: <root> should be the PARENT of the project folders you want as separate ' +
            'sources (e.g. "obsync discover ~/Dev/Personal", not "obsync discover ~/Dev" ' +
            'or "obsync discover ~").\n',
        );
        return;
      }

      intro(`obsync discover ${resolvedRoot}`);

      const selected = await multiselect({
        message: `Found ${candidates.length} candidate(s) — select sources to add`,
        options: candidates.map((c) => {
          const category = inferCategory(c.path);
          const scan = detectScan(c.path);
          const name = detectName(c.path);
          return {
            value: c.path,
            label: c.name,
            hint: `name=${name}, category=${category}, scan=${scan}`,
          };
        }),
        required: false,
      });

      if (isCancel(selected)) {
        cancel('Aborted. obsync.yml unchanged.');
        process.exit(0);
        return;
      }

      if (selected.length === 0) {
        outro('No sources selected.');
        return;
      }

      for (const candidatePath of selected) {
        const result = await runAddFlow(options.config, candidatePath, config.vault.path, false);
        if (result === 'cancelled') {
          // Cancel sentinel during a per-candidate flow aborts the whole
          // discover run cleanly (T-05-07) rather than continuing.
          process.exit(0);
          return;
        }
        if (result === 'error') {
          log.warn(`Skipping "${candidatePath}" due to the error above.`);
        }
      }

      outro('Done.');
    });

  return cmd;
}
