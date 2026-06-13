import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createAntigravityInternalLogForwarder } from './antigravity.js';

const BACKUP_LOG = fileURLToPath(new URL('../../../.agentteams/runner/backup/antigravity.log', import.meta.url));

const skipIfMissing = (t: { skip: (reason: string) => void }) => {
  if (!existsSync(BACKUP_LOG)) {
    t.skip(`Backup log fixture not present at ${BACKUP_LOG}`);
    return true;
  }
  return false;
};

const collectForwardedLines = async () => {
  const forwarded: string[] = [];
  const forwarder = createAntigravityInternalLogForwarder({
    logPath: BACKUP_LOG,
    triggerId: 'replay-trigger',
    onLine: (line) => forwarded.push(line),
    onWarnLine: (line) => forwarded.push(line),
  });

  await forwarder.flush();
  forwarder.stop();
  return forwarded;
};

test('backup Antigravity log replay keeps only readable whitelist events', async (t) => {
  if (skipIfMissing(t)) return;

  const lines = await collectForwardedLines();
  assert.ok(lines.length > 0, 'expected at least one forwarded event');
  assert.ok(lines.length <= 15, `expected at most 15 forwarded events, got ${lines.length}`);

  const noisePatterns = [
    'http_helpers',
    'PlannerResponse without',
    'Singleflight refresh failed',
    'Reloading system slash commands',
    'Experiments refreshed',
    'auto_updater',
  ];
  for (const pattern of noisePatterns) {
    assert.equal(
      lines.some((line) => line.includes(pattern)),
      false,
      `noise leaked: ${pattern}`,
    );
  }

  const requiredSignals = [
    '[Session] Authenticated as',
    '[Session] Project:',
    '[Session] Session started',
    '[Session] Conversation:',
    '[Tool] Edit',
    '[Result] Streamed',
    '[Result] Session ended',
  ];
  for (const signal of requiredSignals) {
    assert.equal(
      lines.some((line) => line.startsWith(signal)),
      true,
      `missing signal: ${signal}`,
    );
  }

  const modelLines = lines.filter((line) => line.startsWith('[Session] Model:'));
  assert.equal(modelLines.length, 1, 'expected exactly one model line');
});
