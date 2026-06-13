import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { resolveRunnerHistoryPaths } from './runner-history.js';

test('resolveRunnerHistoryPaths returns null paths when authPath is missing', () => {
  assert.deepEqual(resolveRunnerHistoryPaths(null, 'trigger-1', 'parent-1'), {
    currentHistoryPath: null,
    parentHistoryPath: null,
  });
});

test('resolveRunnerHistoryPaths returns current and parent history paths', () => {
  const authPath = join('workspace', 'auth');
  assert.deepEqual(resolveRunnerHistoryPaths(authPath, 'trigger-1', 'parent-1'), {
    currentHistoryPath: join(authPath, '.agentteams', 'runner', 'history', 'trigger-1.md'),
    parentHistoryPath: join(authPath, '.agentteams', 'runner', 'history', 'parent-1.md'),
  });
});

test('resolveRunnerHistoryPaths omits parent path when parent trigger is absent', () => {
  const authPath = join('workspace', 'auth');
  assert.deepEqual(resolveRunnerHistoryPaths(authPath, 'trigger-1', null), {
    currentHistoryPath: join(authPath, '.agentteams', 'runner', 'history', 'trigger-1.md'),
    parentHistoryPath: null,
  });
});
