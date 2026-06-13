import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

type AuthPathStore = {
  authPaths: string[];
};

const normalizeAuthPaths = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))];
};

export const getAuthPathStorePath = (): string => {
  return join(homedir(), '.agentteams', 'auth-paths.json');
};

export const loadAuthPaths = (filePath: string = getAuthPathStorePath()): string[] => {
  if (!existsSync(filePath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as AuthPathStore | string[];
    if (Array.isArray(parsed)) {
      return normalizeAuthPaths(parsed);
    }

    return normalizeAuthPaths(parsed.authPaths);
  } catch {
    return [];
  }
};

export const saveAuthPath = (authPath: string, filePath: string = getAuthPathStorePath()): string => {
  const authPaths = loadAuthPaths(filePath);
  if (authPaths.includes(authPath)) {
    return filePath;
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify({ authPaths: [...authPaths, authPath] }, null, 2), 'utf8');
  return filePath;
};
