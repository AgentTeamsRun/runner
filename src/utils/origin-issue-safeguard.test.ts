import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildPlanLinkIssueArgs,
  extractIssueRefsFromPrompt,
  runOriginIssueSafeguard,
} from './origin-issue-safeguard.js';

const PLAN_ID = 'f62762fc-730a-4201-8586-e2541505ed1b';

// CLI(@agentteams/cli)와 러너는 따로 배포되므로, 액션 이름이 어긋나도 런타임에서는
// logger.warn으로만 남습니다. 계약을 CI가 지키도록 인자를 그대로 고정합니다.
test('buildPlanLinkIssueArgs pins the CLI contract to `plan link-issue`', () => {
  const args = buildPlanLinkIssueArgs(PLAN_ID, {
    provider: 'GITHUB',
    externalId: '2021',
    externalUrl: 'https://github.com/rlarua/AgentTeams/issues/2021',
    externalTitle: 'CLI 서브커맨드 전환',
  });

  assert.deepEqual(args, [
    'plan',
    'link-issue',
    '--id',
    PLAN_ID,
    '--provider',
    'GITHUB',
    '--external-id',
    '2021',
    '--external-url',
    'https://github.com/rlarua/AgentTeams/issues/2021',
    '--title',
    'CLI 서브커맨드 전환',
  ]);
  assert.equal(args[1], 'link-issue', 'plan issue 별칭이 아니라 정식 액션 이름을 써야 한다');
});

test('buildPlanLinkIssueArgs falls back to "unknown" url and omits an empty title', () => {
  const args = buildPlanLinkIssueArgs(PLAN_ID, { provider: 'LINEAR', externalId: 'ISS-1', externalUrl: '' });

  assert.deepEqual(args.slice(-2), ['--external-url', 'unknown']);
  assert.equal(args.includes('--title'), false);
});

test('extractIssueRefsFromPrompt reads issue references from text prompts', () => {
  const refs = extractIssueRefsFromPrompt('작업 [#2021](GITHUB_ISSUE:2021) 처리 및 [x](PLAN:abc) 무시');

  assert.deepEqual(refs, [{ provider: 'GITHUB', externalId: '2021', externalUrl: '', externalTitle: '#2021' }]);
});

test('runOriginIssueSafeguard invokes the CLI once per detected plan × issue pair', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'origin-issue-safeguard-'));
  const historyPath = join(dir, 'history.md');
  writeFileSync(historyPath, `plan created: ${PLAN_ID}\n`, 'utf8');

  const calls: Array<{ cwd: string; args: string[] }> = [];
  try {
    await runOriginIssueSafeguard('[#2021](GITHUB_ISSUE:2021)', historyPath, dir, {
      runCli: async (cwd, planId, issue) => {
        calls.push({ cwd, args: buildPlanLinkIssueArgs(planId, issue) });
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, dir);
  assert.deepEqual(calls[0].args.slice(0, 4), ['plan', 'link-issue', '--id', PLAN_ID]);
});

test('runOriginIssueSafeguard stays silent when the prompt has no issue reference', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'origin-issue-safeguard-'));
  const historyPath = join(dir, 'history.md');
  writeFileSync(historyPath, `plan created: ${PLAN_ID}\n`, 'utf8');

  let called = false;
  try {
    await runOriginIssueSafeguard('이슈 참조 없음', historyPath, dir, {
      runCli: async () => {
        called = true;
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(called, false);
});
