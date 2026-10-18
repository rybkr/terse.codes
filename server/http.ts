import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { isIP } from 'node:net';
import { allowedOrigins } from './accounts.js';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import { TRPC_ERROR_CODES_BY_KEY } from '@trpc/server/rpc';
import type { AppRouter } from './router.js';

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf',
};

export function createAppServer(router: AppRouter, directory = resolve('frontend/dist'), options: { health?: () => boolean; webhook?: (request: Request) => Promise<Response> } = {}) {
  const rpc = createHTTPHandler({
    router,
    basePath: '/trpc/',
    maxBodySize: 1_000_000,
    createContext: ({ req }) => {
      const authorization = req.headers.authorization;
      const forwarded = req.headers['fly-client-ip'];
      const ip = process.env.FLY_APP_NAME && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : req.socket.remoteAddress;
      return { token: authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined, ip };
    },
  });
  return createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Cache-Control', 'no-store');
    if (process.env.NODE_ENV === 'production') response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    const origin = request.headers.origin;
    if (origin && !allowedOrigins().includes(origin)) {
      response.writeHead(403, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        error: {
          message: 'Origin is not allowed. Open Terse using its configured address.',
          code: TRPC_ERROR_CODES_BY_KEY.FORBIDDEN,
          data: { code: 'FORBIDDEN', httpStatus: 403 },
        },
      }));
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    if (pathname === '/webhooks/clerk' && request.method === 'POST' && options.webhook) {
      void (async () => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
          bytes += buffer.length;
          if (bytes > 65_536) { response.writeHead(413); response.end(); return; }
          chunks.push(buffer);
        }
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === 'string') headers.set(name, value);
        }
        const result = await options.webhook!(new Request('http://localhost/webhooks/clerk', { method: 'POST', headers, body: Buffer.concat(chunks) }));
        response.writeHead(result.status);
        response.end(await result.text());
      })().catch(() => { response.writeHead(500); response.end('Webhook could not be processed.'); });
      return;
    }
    if (pathname.startsWith('/trpc/')) {
      response.setHeader('Cache-Control', 'no-store');
      rpc(request, response);
      return;
    }
    if (pathname === '/health') {
      const healthy = options.health?.() ?? true;
      response.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: healthy }));
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405);
      response.end();
      return;
    }
    void (async () => {
      let file: string;
      try {
        file = resolve(directory, `.${decodeURIComponent(pathname)}`);
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      if (!file.startsWith(`${resolve(directory)}${sep}`)) file = resolve(directory, 'index.html');
      try {
        const information = await stat(file).catch(() => null);
        if (!information?.isFile()) {
          if (extname(pathname)) {
            response.writeHead(404);
            response.end('Not found');
            return;
          }
          file = resolve(directory, 'index.html');
          await stat(file);
        }
        response.writeHead(200, {
          'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream',
          'Cache-Control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
        });
        if (request.method === 'HEAD') response.end();
        else createReadStream(file).on('error', () => response.destroy()).pipe(response);
      } catch {
        response.writeHead(404);
        response.end('Frontend build missing. Run pnpm build.');
      }
    })();
  });
}
