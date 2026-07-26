type FailureMessageOptions = {
  exitCode: number | null;
  lastErrorOutput: string;
  lastOutput: string;
};

export const selectRunnerFailureMessage = ({
  exitCode,
  lastErrorOutput,
  lastOutput,
}: FailureMessageOptions): string | undefined => {
  if (exitCode === 0) return undefined;

  const errorOutput = lastErrorOutput.trim();
  if (errorOutput.length > 0) return errorOutput;

  const output = lastOutput.trim();
  if (output.length > 0) return output;

  return `Runner exited with code ${exitCode ?? 1}`;
};
