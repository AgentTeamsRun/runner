#!/usr/bin/env node
process.title = 'AgentTeams Runner';
import { createRequire } from 'node:module';
import { runInitCommand } from './commands/init.js';
import { runStartCommand } from './commands/start.js';
import { runStatusCommand } from './commands/status.js';
import { runStopCommand } from './commands/stop.js';
import { runUninstallCommand } from './commands/uninstall.js';
import { runCleanupCommand } from './commands/cleanup.js';
import { runRestartCommand } from './commands/restart.js';
import { runUpdateCommand } from './commands/update.js';
import { logger } from './logger.js';
import { buildHelpText } from './help.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version?: string };
const daemonVersion = packageJson.version ?? '0.0.0';

const main = async () => {
  const [, , command, ...args] = process.argv;

  if (command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(buildHelpText());
    return;
  }

  if (command === '-v' || command === '--version' || command === 'version') {
    process.stdout.write(`${daemonVersion}\n`);
    return;
  }

  if (!command || command === 'start') {
    await runStartCommand();
    return;
  }

  if (command === 'init') {
    await runInitCommand(args);
    return;
  }

  if (command === 'status') {
    await runStatusCommand();
    return;
  }

  if (command === 'stop') {
    await runStopCommand();
    return;
  }

  if (command === 'restart') {
    await runRestartCommand();
    return;
  }

  if (command === 'update') {
    await runUpdateCommand();
    return;
  }

  if (command === 'uninstall') {
    await runUninstallCommand();
    return;
  }

  if (command === 'cleanup') {
    await runCleanupCommand(args);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
};

main().catch((error) => {
  logger.error('Daemon exited with error', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
