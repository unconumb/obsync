/**
 * init.ts — obsync init command implementation.
 *
 * Creates obsync.yml from a template with 600 permissions (SEC-01)
 * and appends .env to the project .gitignore (SEC-05).
 *
 * Security notes:
 *   - SEC-01: Config written with mode 0o600 (owner read/write only)
 *   - SEC-05: .env appended to .gitignore to prevent accidental key commits
 *   - File existence check prevents silent overwrites
 */

import * as fs from 'fs';
import path from 'path';

/**
 * OBSYNC_YML_TEMPLATE — minimal valid obsync.yml template with all top-level keys.
 *
 * Placeholder values are clearly non-real so users must update them before running sync.
 * Template is valid YAML parseable by loadConfig() once paths are set to real values.
 */
export const OBSYNC_YML_TEMPLATE = `# obsync.yml — obsync configuration file
# Created by: obsync init
# Permissions: 600 (owner read/write only)
#
# SECURITY: Never store API keys or tokens in this file.
# Load secrets via environment variables or a .env file instead.
# obsync will refuse to start if it detects hardcoded key patterns here.

vault:
  # Absolute path (or ~ for home) to your Obsidian vault root directory.
  path: ~/path/to/your/obsidian/vault

# Optional AI backend configuration.
# Remove this block (or set backend: none) to disable AI summarization entirely.
# ai:
#   backend: ollama      # ollama | claude | openai | none
#   model: qwen3.5:9b    # model name passed to the backend
#                        #   - ollama: e.g. qwen3.5:9b (small/fast/cheap example)
#                        #   - claude: e.g. claude-haiku-4-5 (requires ANTHROPIC_API_KEY env var)
#                        #   - openai: e.g. gpt-4o-mini (requires OPENAI_API_KEY env var)
#   ollama_url: http://localhost:11434   # only used when backend: ollama

sources:
  # Each entry defines a source directory to sync into the vault.
  # Add one entry per project or documentation folder.
  - name: my-project               # used in vault folder names and audit log
    path: ~/path/to/your/project   # absolute or ~ path to source root
    category: 02-areas             # vault category folder (e.g. 01-projects, 02-areas, 03-resources)
    scan: scattered                # scattered | docs (scattered = all .md files in tree)
    ai_summary: false              # true to enable AI summaries for this source (default: false)
    # docs_path: docs              # only for scan: docs — subfolder to scan relative to path
    # ignore:                      # per-source glob patterns to exclude
    #   - "**/*.draft.md"
    # labels:                      # labels for Phase 2 cross-source index pages
    #   - runbook

# Global ignore patterns applied to all sources.
# Pattern formats supported by shouldIgnore:
#   - "dirname/"       → matches the named directory anywhere in the path
#   - "*.ext"          → matches files with the given extension
#   - "exact-name.md"  → exact filename or path segment match
ignore:
  - ".git/"
  - "node_modules/"
  - "vendor/"
  - ".DS_Store"

# Optional: path to the audit log file.
# Defaults to ~/.obsync/audit.log if not set.
# audit_log: ~/.obsync/audit.log
`;

/**
 * initConfig — create obsync.yml template and update .gitignore.
 *
 * @param configPath - Path where obsync.yml will be created (absolute or relative)
 * @param cwd - Working directory for .gitignore detection (defaults to process.cwd();
 *              pass explicitly in tests for isolation without process.chdir)
 */
export function initConfig(configPath: string, cwd: string = process.cwd()): void {
  const resolvedConfigPath = path.resolve(configPath);

  // Guard: refuse to overwrite an existing config file without explicit consent
  if (fs.existsSync(resolvedConfigPath)) {
    throw new Error(
      `obsync.yml already exists at ${resolvedConfigPath}. Remove it first or use a different path.`
    );
  }

  // Write YAML template atomically: write to .obsync.tmp, chmod, then rename.
  // This avoids a broken state if the process is killed between write and chmod.
  // A partial write leaves the .tmp file (not the final config), so re-init succeeds.
  // TODO(XPLAT-01): fs.chmod/chmodSync is a no-op on Windows (Pitfall 6).
  // Windows ACL-based permission enforcement is a future enhancement.
  const tmpConfigPath = resolvedConfigPath + '.obsync.tmp';
  try {
    fs.writeFileSync(tmpConfigPath, OBSYNC_YML_TEMPLATE, { mode: 0o600 });
    fs.chmodSync(tmpConfigPath, 0o600);
    fs.renameSync(tmpConfigPath, resolvedConfigPath);
  } catch (err) {
    try { fs.unlinkSync(tmpConfigPath); } catch { /* ignore — tmp may not exist */ }
    throw err;
  }

  process.stdout.write(`Created obsync.yml at ${resolvedConfigPath} (permissions: 600)\n`);

  // Update .gitignore: append .env if not already present (SEC-05)
  const gitignorePath = path.join(cwd, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, 'utf-8');

    // Check if .env line already exists (trim each line before comparing)
    const lines = content.split('\n');
    const alreadyHasEnv = lines.some((line) => line.trim() === '.env');

    if (!alreadyHasEnv) {
      const updatedContent = content.endsWith('\n')
        ? content + '.env\n'
        : content + '\n.env\n';
      fs.writeFileSync(gitignorePath, updatedContent);
      process.stdout.write('Added .env to .gitignore\n');
    }
  } else {
    process.stdout.write(
      'Note: no .gitignore found in current directory. Add .env to .gitignore manually.\n'
    );
  }
}
