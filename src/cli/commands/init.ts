import { Command } from 'commander';
import { initConfig } from '../../config/init';

export function buildInitCommand(): Command {
  const cmd = new Command('init');

  cmd
    .description('Create a new obsync.yml configuration file')
    .option('-c, --config <path>', 'Path to obsync.yml', 'obsync.yml')
    .action((options: { config: string }) => {
      try {
        initConfig(options.config);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`Error: ${message}\n`);
        process.exit(1);
      }
    });

  return cmd;
}
