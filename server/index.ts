import { createAppServer } from './http.js';
import { appRouter, rooms, persistence } from './router.js';
import { validateConfiguration } from './config.js';
import { clerkWebhook } from './webhooks.js';
import { verifyRunnerIsolation } from './sandbox.js';
import { shutdownRunner } from './runner.js';
import { shutdownServer } from './shutdown.js';

const port = Number(process.env.BACKEND_PORT ?? process.env.PORT ?? 8000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BACKEND_PORT or PORT must be between 1 and 65535.');
validateConfiguration();
await verifyRunnerIsolation();
let stopping = false;
const server = createAppServer(appRouter, undefined, {
  health: () => !stopping && persistence.healthy,
  webhook: (request) => clerkWebhook(request, rooms),
});
const ticker = setInterval(() => {
  rooms.tick();
  void persistence.flush().catch(() => console.error('Stats could not be saved. They remain queued for retry.'));
}, 1000);
ticker.unref();
server.listen(port, '0.0.0.0', () => console.log(`Terse listening on http://localhost:${port}`));

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(ticker);
  const deadline = setTimeout(() => {
    console.error('Shutdown exceeded its 25-second deadline.');
    process.exit(1);
  }, 25_000);
  deadline.unref();
  await shutdownServer(server, shutdownRunner, () => persistence.flush());
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
