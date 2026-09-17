import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 32109);
// Optional request journal. The lifecycle harness needs an observer that is
// independent of the runner to prove the server actually received polls — the
// runner's own diagnostics cannot stand as evidence that it kept talking.
const requestLogPath = process.argv[3] ?? null;

const recordRequest = (url) => {
  if (!requestLogPath) {
    return;
  }
  try {
    appendFileSync(requestLogPath, `${new Date().toISOString()} ${url}\n`, 'utf8');
  } catch {
    // The journal is evidence, not a dependency — never fail a request over it.
  }
};

const server = createServer((request, response) => {
  recordRequest(request.url ?? '');
  response.setHeader('content-type', 'application/json');
  if (request.url === '/api/daemons/me') {
    response.end(
      JSON.stringify({
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
      }),
    );
    return;
  }
  if (request.url === '/api/daemon-triggers/poll-state') {
    response.end(
      JSON.stringify({
        data: {
          orphanedCancelRequestedTriggerIds: [],
          pendingWorktreeRemovals: [],
          pendingTrigger: null,
        },
      }),
    );
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: 'not found' }));
});

server.listen(port, '127.0.0.1');
