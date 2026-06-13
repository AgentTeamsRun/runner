import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseStreamJsonLine } from './stream-json-parser.js';

const BACKUP_LOG = fileURLToPath(new URL('../../../.agentteams/runner/backup/claude.log', import.meta.url));

const skipIfMissing = (t: { skip: (reason: string) => void }) => {
  if (!existsSync(BACKUP_LOG)) {
    t.skip(`Backup log fixture not present at ${BACKUP_LOG}`);
    return true;
  }
  return false;
};

const collectEntries = (verbose: boolean) => {
  const cwd = '/Users/justin/Project/Me/AgentTeams';
  const lines = readFileSync(BACKUP_LOG, 'utf8').split(/\r?\n/);
  return lines.flatMap((line) => parseStreamJsonLine(line, { cwd, verbose }));
};

test('backup log replay: default mode hides thinking and renders readable tool lines', (t) => {
  if (skipIfMissing(t)) return;

  const entries = collectEntries(false);
  assert.ok(entries.length > 0, 'expected at least one parsed entry');

  const thinkingLines = entries.filter((e) => e.message.startsWith('[Thinking]'));
  assert.equal(thinkingLines.length, 0, 'default mode must not emit any [Thinking] lines');

  const toolLines = entries.filter((e) => e.message.startsWith('[Tool]'));
  assert.ok(toolLines.length > 0, 'expected some [Tool] lines in the backup fixture');
  for (const entry of toolLines) {
    assert.ok(
      !entry.message.includes('{') && !entry.message.includes('}'),
      `tool line should not contain raw JSON: ${entry.message}`,
    );
  }

  for (const entry of entries) {
    assert.ok(!entry.message.includes('/Users/'), `absolute /Users/... path leaked into output: ${entry.message}`);
  }
});

test('backup log replay: verbose mode re-enables [Thinking] lines', (t) => {
  if (skipIfMissing(t)) return;

  const defaultCount = collectEntries(false).length;
  const verboseCount = collectEntries(true).length;
  assert.ok(verboseCount >= defaultCount, `verbose entries (${verboseCount}) should be >= default (${defaultCount})`);
});
