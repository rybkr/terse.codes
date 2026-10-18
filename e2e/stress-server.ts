import { createAppServer } from '../server/http.js';
import { Persistence } from '../server/persistence.js';
import { ProblemRepository } from '../server/problems.js';
import { createRouter } from '../server/router.js';
import { RoomStore } from '../server/rooms.js';

if (process.env.NODE_ENV === 'production' || !process.env.CLERK_SECRET_KEY?.startsWith('sk_test_')) {
  throw new Error('Stress tests require Clerk development credentials.');
}

const problems = new ProblemRepository();
const summaryRanges = problems.get('summary-ranges');
const persistence = new Persistence();
const rooms = new RoomStore(() => summaryRanges, undefined, undefined, { onEvent: (event) => persistence.enqueue(event) });
const router = createRouter(rooms, undefined, () => persistence.flush());
const server = createAppServer(router, undefined, { health: () => persistence.healthy });
const ticker = setInterval(() => {
  rooms.tick();
  void persistence.flush().catch(() => console.error('Stress-test stats remain queued.'));
}, 1000);
const port = Number(new URL(process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3011').port);
server.listen(port, '127.0.0.1', () => console.log(`Stress server listening on ${port}`));
async function shutdown() {
  clearInterval(ticker);
  server.close();
  server.closeAllConnections();
  await persistence.flush();
}
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
