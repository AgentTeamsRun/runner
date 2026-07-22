import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  loadDiscoveredWorktreeMappings,
  resolveDiscoveredWorktreePath,
  saveDiscoveredWorktreeMappings,
} from './discovered-worktree-store.js';

test('discovered worktree store: save/load round-trip and path resolution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dw-store-'));
  try {
    const file = join(dir, 'discovered-worktrees.json');
    saveDiscoveredWorktreeMappings({ 'key-1': '/repo/.wt/a', 'key-2': '/repo/.wt/b' }, file);

    const loaded = loadDiscoveredWorktreeMappings(file);
    assert.deepEqual(loaded, { 'key-1': '/repo/.wt/a', 'key-2': '/repo/.wt/b' });
    assert.equal(resolveDiscoveredWorktreePath('key-1', file), '/repo/.wt/a');
    assert.equal(resolveDiscoveredWorktreePath('missing', file), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('discovered worktree store: missing file and malformed JSON degrade to empty map', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dw-store-'));
  try {
    const missing = join(dir, 'nope.json');
    assert.deepEqual(loadDiscoveredWorktreeMappings(missing), {});

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not valid json', 'utf8');
    assert.deepEqual(loadDiscoveredWorktreeMappings(bad), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
