import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? 32109);
const server = createServer((request, response) => {
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
