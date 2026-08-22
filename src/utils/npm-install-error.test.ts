import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyInstallError,
  describeInstallError,
  normalizeInstallError,
  requiresManualFix,
} from './npm-install-error.js';

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

const EEXIST_INSTALL_ERROR_MESSAGE = [
  'Command failed: /usr/bin/npm install -g @agentteams/cli@0.0.114',
  'npm ERR! code EEXIST',
  'npm ERR! path /usr/local/bin/agt',
  'npm ERR! EEXIST: file already exists',
  'npm ERR! File exists: /usr/local/bin/agt',
].join('\n');

test('describeInstallError guides the user to clear a conflicting global bin file', () => {
  // `agt`/`agr` bin이 늘어난 뒤 새로 열린 실패 경로다. 원시 npm 출력만 보여주면 조치를 알 수 없다.
  const described = describeInstallError(new Error(EEXIST_INSTALL_ERROR_MESSAGE));
  assert.match(described, /already taken by a file from another source/u);
  assert.match(described, /remove or rename that file/u);
});

test('requiresManualFix covers both permission blocks and global bin conflicts', () => {
  assert.equal(requiresManualFix(new Error('npm ERR! code EACCES')), true);
  assert.equal(requiresManualFix(new Error(EEXIST_INSTALL_ERROR_MESSAGE)), true);
  assert.equal(requiresManualFix(new Error('npm ERR! File exists: /usr/local/bin/agr')), true);
  assert.equal(requiresManualFix(new Error('network unavailable')), false);
});

test('a bin conflict keeps reporting UNKNOWN so the server reason contract stays unchanged', () => {
  assert.equal(classifyInstallError(new Error(EEXIST_INSTALL_ERROR_MESSAGE)), 'UNKNOWN');
});
