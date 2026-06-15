import dotenv from 'dotenv';
import { Command } from 'commander';
import { buildSyncCommand } from './commands/sync';
import { buildStatusCommand } from './commands/status';
import { buildInitCommand } from './commands/init';
import { buildWatchCommand } from './commands/watch';
import { buildAddCommand } from './commands/add';
import { buildDiscoverCommand } from './commands/discover';
import {
  buildInstallServiceCommand,
  buildUninstallServiceCommand,
  buildServiceCommand,
} from './commands/service';

// Load ANTHROPIC_API_KEY/OPENAI_API_KEY etc. from a .env file in cwd, if present.
// quiet: true suppresses dotenv's "[dotenv@x.y.z] injecting env" stdout banner
// (D-09) — without it, `obsync status --json` stdout would not start with `{`
// and JSON.parse would fail for downstream consumers (e.g. the menu bar widget).
dotenv.config({ quiet: true });

const program = new Command();

program
  .name('obsync')
  .description('Sync markdown documentation from multiple project folders into an Obsidian vault')
  .version('0.1.0');

program.addCommand(buildSyncCommand());
program.addCommand(buildStatusCommand());
program.addCommand(buildInitCommand());
program.addCommand(buildWatchCommand());
program.addCommand(buildAddCommand());
program.addCommand(buildDiscoverCommand());
program.addCommand(buildInstallServiceCommand());
program.addCommand(buildUninstallServiceCommand());
program.addCommand(buildServiceCommand());

program.parseAsync(process.argv);
