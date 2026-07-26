import assert from 'node:assert/strict';
import test from 'node:test';
import { selectRunnerFailureMessage } from './failure-message.js';

const cases = [
  {
    name: 'returns undefined for a successful exit',
    options: { exitCode: 0, lastErrorOutput: 'ignored error', lastOutput: 'ignored output' },
    expected: undefined,
  },
  {
    name: 'prefers the trimmed error-channel output',
    options: { exitCode: 1, lastErrorOutput: '  specific error  ', lastOutput: 'general output' },
    expected: 'specific error',
  },
  {
    name: 'falls back to trimmed general output',
    options: { exitCode: 2, lastErrorOutput: ' \n ', lastOutput: '  general output  ' },
    expected: 'general output',
  },
  {
    name: 'ignores whitespace-only output and returns the exit code',
    options: { exitCode: 3, lastErrorOutput: '\t', lastOutput: '\n' },
    expected: 'Runner exited with code 3',
  },
  {
    name: 'returns the exit code when no output was captured',
    options: { exitCode: 4, lastErrorOutput: '', lastOutput: '' },
    expected: 'Runner exited with code 4',
  },
  {
    name: 'uses exit code 1 when the process exit code is null',
    options: { exitCode: null, lastErrorOutput: '', lastOutput: '' },
    expected: 'Runner exited with code 1',
  },
] as const;

for (const { name, options, expected } of cases) {
  test(name, () => {
    assert.equal(selectRunnerFailureMessage(options), expected);
  });
}
