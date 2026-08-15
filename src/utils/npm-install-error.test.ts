import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyInstallError, describeInstallError, normalizeInstallError } from './npm-install-error.js';

test('classifyInstallError detects permission failures from real npm output', () => {
  const eacces = new Error(
    [
      'Command failed: /usr/bin/npm install -g @agentteams/runner@0.0.114',
      'npm ERR! code EACCES',
      'npm ERR! syscall rename',
      'npm ERR! errno -13',
    ].join('\n'),
  );

  assert.equal(classifyInstallError(eacces), 'PERMISSION_DENIED');
  assert.equal(classifyInstallError(new Error('npm ERR! code EPERM')), 'PERMISSION_DENIED');
  assert.equal(classifyInstallError(new Error('sh: Permission denied')), 'PERMISSION_DENIED');
});

test('classifyInstallError falls back to UNKNOWN for other failures', () => {
  assert.equal(classifyInstallError(new Error('network unavailable')), 'UNKNOWN');
  assert.equal(classifyInstallError('ETARGET no matching version'), 'UNKNOWN');
});

test('describeInstallError keeps the remediation wording for permission failures', () => {
  assert.match(describeInstallError(new Error('npm ERR! code EACCES')), /elevated permissions/);
  assert.match(describeInstallError(new Error('network unavailable')), /Failed to install the latest AgentRunner/);
});

test('normalizeInstallError returns an Error carrying the described message', () => {
  const normalized = normalizeInstallError(new Error('npm ERR! code EACCES'));
  assert.ok(normalized instanceof Error);
  assert.equal(normalized.message, describeInstallError(new Error('npm ERR! code EACCES')));
});
