const coActionIdPattern = /COACTION_ID\s*:\s*([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/i;

export const extractCoActionId = (input: string): string | null => {
  const match = coActionIdPattern.exec(input);
  if (!match?.[1]) {
    return null;
  }

  return match[1].toLowerCase();
};
