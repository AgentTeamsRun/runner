#!/usr/bin/env node
import { runInitCommand } from "./commands/init.js";
import { runStartCommand } from "./commands/start.js";
import { logger } from "./logger.js";

const main = async () => {
  const [, , command, ...args] = process.argv;

  if (!command || command === "start") {
    await runStartCommand();
    return;
  }

  if (command === "init") {
    await runInitCommand(args);
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
