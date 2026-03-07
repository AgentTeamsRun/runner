import { restartDaemon } from "../daemon-control.js";
import { logger } from "../logger.js";

export const runRestartCommand = async (): Promise<void> => {
  await restartDaemon();
  logger.info("AgentRunner restart completed");
};
