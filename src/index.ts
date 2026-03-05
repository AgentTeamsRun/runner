#!/usr/bin/env node
import { createRequire } from "node:module";
import { runInitCommand } from "./commands/init.js";
import { runStartCommand } from "./commands/start.js";
import { runStatusCommand } from "./commands/status.js";
import { runStopCommand } from "./commands/stop.js";
import { runUninstallCommand } from "./commands/uninstall.js";
import { runCleanupCommand } from "./commands/cleanup.js";
import { logger } from "./logger.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: string };
const daemonVersion = packageJson.version ?? "0.0.0";

const helpText = `Usage: agentrunner [command] [options]

Commands:
  start                       Start daemon polling (default)
  init --token <token>        Initialize daemon config and register autostart
  status                      Show daemon and autostart status
  stop                        Stop running daemon
  uninstall                   Stop daemon, remove autostart, clean up
  cleanup --path <path>       Purge expired runner log/history files

Options:
  --no-autostart              Skip autostart registration (init only)
  -h, --help                  Show help
  -v, --version               Show version
`;

const main = async () => {
  const [, , command, ...args] = process.argv;

  if (command === "-h" || command === "--help" || command === "help") {
    process.stdout.write(helpText);
    return;
  }

  if (command === "-v" || command === "--version" || command === "version") {
    process.stdout.write(`${daemonVersion}\n`);
    return;
  }

  if (!command || command === "start") {
    await runStartCommand();
    return;
  }

  if (command === "init") {
    await runInitCommand(args);
    return;
  }

  if (command === "status") {
    await runStatusCommand();
    return;
  }

  if (command === "stop") {
    await runStopCommand();
    return;
  }

  if (command === "uninstall") {
    await runUninstallCommand();
    return;
  }

  if (command === "cleanup") {
    await runCleanupCommand(args);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
};

main().catch((error) => {
  logger.error("Daemon exited with error", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exit(1);
});
