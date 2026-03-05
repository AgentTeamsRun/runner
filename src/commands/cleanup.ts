import { runCleanup } from "../utils/runner-cleanup.js";

export const runCleanupCommand = async (args: string[]): Promise<void> => {
  const pathIndex = args.indexOf("--path");
  if (pathIndex === -1 || pathIndex + 1 >= args.length) {
    process.stderr.write("Error: --path <projectRoot> is required.\n");
    process.exit(1);
  }

  const authPath = args[pathIndex + 1];
  await runCleanup(authPath);
  process.stdout.write("Cleanup completed.\n");
};
