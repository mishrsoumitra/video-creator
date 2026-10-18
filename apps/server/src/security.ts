import { CLIENT_HEADER, CLIENT_HEADER_VALUE } from '@vc/config';
import type { FastifyInstance } from 'fastify';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/;
const ASSET_ROUTE = /^\/api\/(jobs\/[^/]+\/assets|media)\//;

/**
 * The server holds API keys and can spend money, and it listens on localhost where any web page
 * could reach it. So: only our own Host names (DNS rebinding), and mutating requests only from our
 * own origins, carrying a custom header that cross-site forms and simple requests cannot send.
 */
export const registerSecurity = (
  app: FastifyInstance,
  {
    allowedHosts,
    allowedOrigins,
  }: { allowedHosts: readonly string[]; allowedOrigins: readonly string[] },
) => {
  const hosts = new Set(allowedHosts.map((h) => h.toLowerCase()));
  const origins = new Set(allowedOrigins);
  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');

    if (!hosts.has((request.headers.host ?? '').toLowerCase())) {
      return reply
        .code(403)
        .send({ error: { code: 'bad_host', message: 'Unexpected Host header.' } });
    }

    const origin = request.headers.origin;
    if (
      request.method === 'GET' &&
      origin &&
      LOCAL_ORIGIN.test(origin) &&
      ASSET_ROUTE.test(request.url)
    ) {
      // The Remotion renderer serves its bundle from another localhost port and reads these assets.
      reply.header('access-control-allow-origin', origin);
      reply.header('vary', 'Origin');
    }

    if (MUTATING.has(request.method)) {
      if (origin && !origins.has(origin)) {
        return reply.code(403).send({
          error: {
            code: 'forbidden_origin',
            message: 'Requests from this origin are not allowed.',
          },
        });
      }
      if (request.headers[CLIENT_HEADER] !== CLIENT_HEADER_VALUE) {
        return reply.code(403).send({
          error: { code: 'forbidden_origin', message: `Missing the ${CLIENT_HEADER} header.` },
        });
      }
    }
    return undefined;
  });
};
