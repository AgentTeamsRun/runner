import { DaemonApiClient } from "../api-client.js";
import { logger } from "../logger.js";
import { resolveApiUrlForInit, writeDaemonConfigFile } from "../config.js";
import { registerAutostart } from "../autostart.js";

type InitOptions = {
  token?: string;
  apiUrl?: string;
  noAutostart: boolean;
};

const parseInitArgs = (argv: string[]): InitOptions => {
  const options: InitOptions = { noAutostart: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--token") {
      options.token = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--api-url") {
      options.apiUrl = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === "--no-autostart") {
      options.noAutostart = true;
    }
  }

  return options;
};

export const runInitCommand = async (argv: string[]): Promise<void> => {
  const options = parseInitArgs(argv);

  if (!options.token || options.token.trim().length === 0) {
    throw new Error("Missing token. Usage: agentrunner init --token <token> [--api-url <url>] [--no-autostart]");
  }

  const apiUrl = await resolveApiUrlForInit(options.apiUrl);
  const daemonToken = options.token.trim();

  const client = new DaemonApiClient(apiUrl, daemonToken);
  const daemon = await client.validateDaemonToken();

  const configPath = await writeDaemonConfigFile({
    daemonToken,
    apiUrl
  });

  logger.info("Daemon init completed", {
    daemonId: daemon.id,
    memberId: daemon.memberId,
    osType: daemon.osType,
    configPath
  });

  if (!options.noAutostart) {
    const result = await registerAutostart({ token: daemonToken, apiUrl });

    if (result.registered) {
      logger.info("Autostart registered", {
        platform: result.platform,
        servicePath: result.servicePath
      });
    }
  } else {
    logger.info("Autostart skipped (--no-autostart)");
  }
};
