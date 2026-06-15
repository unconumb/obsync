import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import path from 'path';

/**
 * index.spawn.test.ts — CLI-spawn regression test for D-09 (dotenv quiet fix).
 *
 * Spawns the BUILT dist/cli/index.js (not buildStatusCommand in-process) so
 * src/cli/index.ts's top-level `dotenv.config()` call actually executes.
 * In-process tests (e.g. status.test.ts) call buildStatusCommand directly and
 * never load index.ts, so they cannot catch a dotenv stdout banner regression.
 *
 * `obsync status --json` (STATUS-03) must emit stdout whose first
 * non-whitespace character is `{` and that JSON.parse()s cleanly — this is
 * the contract the Phase 10 menu bar widget's cold-start status read relies on.
 */

const distPath = path.resolve(__dirname, '../../dist/cli/index.js');

const MINIMAL_OBSYNC_YML = `vault:
  path: __VAULT_PATH__

sources:
  - name: spawn-test-source
    path: __SOURCE_PATH__
    category: 02-areas
    scan: scattered
    ai_summary: false

ignore:
  - ".git/"
`;

describe('CLI spawn — obsync status --json (D-09)', () => {
  if (!fs.existsSync(distPath)) {
    it.skip('skipped: dist/cli/index.js not found — run `npm run build` first', () => {});
    return;
  }

  it('emits pure-JSON stdout (no dotenv banner)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obsync-spawn-'));

    try {
      const vaultPath = path.join(tmpDir, 'vault');
      const sourcePath = path.join(tmpDir, 'source');
      fs.mkdirSync(vaultPath, { recursive: true });
      fs.mkdirSync(sourcePath, { recursive: true });

      const configContent = MINIMAL_OBSYNC_YML
        .replace('__VAULT_PATH__', vaultPath)
        .replace('__SOURCE_PATH__', sourcePath);
      const configPath = path.join(tmpDir, 'obsync.yml');
      fs.writeFileSync(configPath, configContent, { mode: 0o600 });
      fs.chmodSync(configPath, 0o600);

      const stateDir = path.join(tmpDir, '.obsync-state');
      fs.mkdirSync(stateDir, { recursive: true });

      const result = spawnSync('node', [distPath, 'status', '--json'], {
        encoding: 'utf-8',
        cwd: tmpDir,
        env: {
          ...process.env,
          OBSYNC_STATE_DIR: stateDir,
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.stdout.trimStart().startsWith('{')).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
