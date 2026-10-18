import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

if (process.env.NODE_ENV === 'production') throw new Error('Use the deployment secret manager for production configuration.');
const generated = !process.env.TERSE_SERVER_SECRET;
const secret = process.env.TERSE_SERVER_SECRET ?? randomBytes(32).toString('hex');
const result = spawnSync('pnpm', ['exec', 'convex', 'env', 'set', 'TERSE_SERVER_SECRET'], {
  input: `${secret}\n`, encoding: 'utf8',
});
if (result.status !== 0) throw new Error('Could not configure the Convex development service secret. Check the configured development deployment.');
if (generated) appendFileSync('.env.local', `\nTERSE_SERVER_SECRET=${secret}\n`);
console.log('Development service secret configured. Its value was not displayed.');
