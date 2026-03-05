import { join } from "node:path";

type RunnerHistoryPaths = {
  currentHistoryPath: string | null;
  parentHistoryPath: string | null;
};

const historyDirectory = (authPath: string) => join(authPath, ".agentteams", "runner", "history");

const historyFilePath = (authPath: string, triggerId: string) => join(historyDirectory(authPath), `${triggerId}.md`);

export const resolveRunnerHistoryPaths = (
  authPath: string | null,
  triggerId: string,
  parentTriggerId: string | null
): RunnerHistoryPaths => {
  if (!authPath) {
    return { currentHistoryPath: null, parentHistoryPath: null };
  }

  return {
    currentHistoryPath: historyFilePath(authPath, triggerId),
    parentHistoryPath: parentTriggerId ? historyFilePath(authPath, parentTriggerId) : null
  };
};
