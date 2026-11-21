import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 32109);
// Optional request journal. The lifecycle harness needs an observer that is
// independent of the runner to prove the server actually received polls — the
// runner's own diagnostics cannot stand as evidence that it kept talking.
const requestLogPath = process.argv[3] ?? null;
// Optional workspace for a test run. When set, the harness can queue one
// trigger at a time through `/__test/offer-trigger` and the runner executes it
// there, so a stop or restart can be observed while a run is active.
const runWorkDir = process.argv[4] ?? null;

let pendingTriggerId = null;

const journal = (line) => {
  if (!requestLogPath) {
    return;
  }
  try {
    appendFileSync(requestLogPath, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    // The journal is evidence, not a dependency — never fail a request over it.
  }
};

const toTrigger = (id) => {
  const now = new Date().toISOString();
  return {
    id,
    prompt: 'wait',
    runnerType: 'OPENCODE',
    model: null,
    fastMode: false,
    effort: null,
    idleTimeoutMs: null,
    status: 'PENDING',
    agentConfigId: 'ci-agent',
    startedAt: null,
    errorMessage: null,
    worktreeError: null,
    lastHeartbeatAt: null,
    conversationId: null,
    parentTriggerId: null,
    createdByMemberId: 'ci-member',
    targetDaemonId: null,
    planMode: false,
    claimedByDaemonId: null,
    useWorktree: false,
    baseBranch: null,
    worktreeId: null,
    worktreeStatus: null,
    createdAt: now,
    updatedAt: now,
  };
};

const server = createServer((request, response) => {
  const url = request.url ?? '';
  journal(url);
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    response.setHeader('content-type', 'application/json');
    const send = (payload) => response.end(JSON.stringify(payload));

    if (url === '/api/daemons/me') {
      send({
        data: {
          id: 'ci-daemon',
          memberId: 'ci-member',
          label: 'Windows CI',
          osType: 'WINDOWS',
          runnerVersion: null,
          supportedEngines: [],
          lastSeenAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });
      return;
    }
    if (url === '/api/daemon-triggers/poll-state') {
      const triggerId = pendingTriggerId;
      pendingTriggerId = null;
      send({
        data: {
          orphanedCancelRequestedTriggerIds: [],
          pendingWorktreeRemovals: [],
          pendingTrigger: triggerId ? toTrigger(triggerId) : null,
        },
      });
      return;
    }

    if (runWorkDir) {
      const offer = /^\/__test\/offer-trigger\/([\w-]+)$/u.exec(url);
      if (offer) {
        pendingTriggerId = offer[1];
        send({ data: { offered: offer[1] } });
        return;
      }
      const trigger = /^\/api\/daemon-triggers\/([\w-]+)\/([a-z/-]+)$/u.exec(url);
      if (trigger?.[2] === 'runtime') {
        send({
          data: {
            triggerId: trigger[1],
            agentConfigId: 'ci-agent',
            authPath: runWorkDir,
            apiKey: 'ci-key',
            teamId: 'ci-team',
            projectId: 'ci-project',
            runnerPrompt: 'wait until stopped',
            parentHistoryMarkdown: null,
            useWorktree: false,
            baseBranch: null,
            worktreeId: null,
            conventions: [],
          },
        });
        return;
      }
      if (trigger?.[2] === 'status' && request.method === 'PATCH') {
        // The final status is the evidence a stop or restart is judged by, so it
        // goes to the journal in a form the harness can match exactly.
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // Journal whatever arrived; an unparsable body simply will not match.
        }
        journal(`STATUS ${trigger[1]} ${body.status ?? ''} ${body.errorMessage ?? ''}`);
        send({ data: {} });
        return;
      }
      if (url.startsWith('/api/daemon-triggers/cancel-status/')) {
        send({ data: { cancelRequested: false } });
        return;
      }
      if (url === '/api/daemon-triggers/discovery-repositories') {
        send({ data: { repositories: [] } });
        return;
      }
      if (url.startsWith('/api/daemon')) {
        send({ data: {} });
        return;
      }
    }

    response.statusCode = 404;
    send({ error: 'not found' });
  });
});

server.listen(port, '127.0.0.1');
