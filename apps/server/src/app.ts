import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import {
  VaultBackendError,
  VaultCorruptError,
  VaultLockedError,
  VaultPassphraseError,
  VaultSetupError,
  WeakPassphraseError,
  createScrubbingStream,
} from '@vc/secrets';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { HttpError } from './http-error';
import { JobManager } from './jobs';
import { registerRoutes } from './routes';
import { registerSecurity } from './security';
import type { ServerDeps } from './services';
import { Credentials, SetupService } from './setup';

/** Recordings and music beds; generous, but bounded. */
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["xi-api-key"]',
  'req.headers["x-goog-api-key"]',
  'req.headers["ocp-apim-subscription-key"]',
  'req.headers["x-subscription-token"]',
];

export const buildApp = async (deps: ServerDeps): Promise<FastifyInstance> => {
  const app = Fastify({
    logger:
      deps.logger === false
        ? false
        : {
            level: deps.logger?.level ?? 'info',
            // Every log line passes through the scrubber, which knows every stored key.
            stream: createScrubbingStream(deps.logger?.stream ?? process.stdout, deps.scrubber),
            redact: REDACT,
          },
    bodyLimit: 2 * 1024 * 1024,
  });

  registerSecurity(app, deps);
  await app.register(fastifyMultipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
  await app.register(fastifyStatic, { root: deps.dataDir, serve: false });

  const credentials = new Credentials(deps);
  const setup = new SetupService(deps, credentials);
  const jobs = new JobManager(deps, setup);

  app.setErrorHandler((error: FastifyError, request, reply) => {
    const send = (
      status: number,
      code: string,
      message: string,
      extra: Record<string, unknown> = {},
    ) =>
      reply.code(status).send({ error: { code, message: deps.scrubber.scrub(message), ...extra } });
    if (error instanceof HttpError)
      return send(
        error.status,
        error.code,
        error.message,
        error.fields ? { fields: error.fields } : {},
      );
    if (error instanceof VaultLockedError) return send(423, 'vault_locked', error.message);
    if (error instanceof VaultPassphraseError)
      return send(401, 'wrong_passphrase', 'That passphrase is not right.');
    if (error instanceof WeakPassphraseError) return send(400, 'weak_passphrase', error.message);
    if (error instanceof VaultSetupError) return send(409, 'vault_setup', error.message);
    if (error instanceof VaultCorruptError) return send(500, 'vault_corrupt', error.message);
    if (error instanceof VaultBackendError) return send(503, 'vault_unavailable', error.message);
    if (error.code === 'FST_REQ_FILE_TOO_LARGE')
      return send(413, 'too_large', 'That file is too large.');
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500)
      return send(error.statusCode, 'invalid_request', error.message);
    request.log.error({ err: error }, 'request failed');
    return send(500, 'internal', 'Something went wrong on the server.');
  });

  registerRoutes(app, { deps, setup, credentials, jobs });

  if (deps.webDistDir) {
    const webDistDir = deps.webDistDir;
    await app.register(fastifyStatic, {
      root: webDistDir,
      prefix: '/',
      decorateReply: false,
      wildcard: false,
      index: ['index.html'],
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/') || request.method !== 'GET') {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Not found.' } });
      }
      return reply.sendFile('index.html', webDistDir);
    });
  }

  app.addHook('onReady', async () => {
    await credentials.loadIntoScrubber();
    jobs.recover();
  });
  app.decorate('jobs', jobs);
  return app;
};
