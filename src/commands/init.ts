import { DaemonApiClient } from "../api-client.js";
import { logger } from "../logger.js";
import { resolveApiUrlForInit, writeDaemonConfigFile } from "../config.js";

type InitOptions = {
  token?: string;
  apiUrl?: string;
};

const parseInitArgs = (argv: string[]): InitOptions => {
  const options: InitOptions = {};

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
    }
  }

  return options;
};

export const runInitCommand = async (argv: string[]): Promise<void> => {
  const options = parseInitArgs(argv);

  if (!options.token || options.token.trim().length === 0) {
    throw new Error("Missing token. Usage: agentteams-daemon init --token <token> [--api-url <url>]");
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
    configPath
  });
};
