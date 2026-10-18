import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { createOpenverseSource, createPageFetcher } from '@vc/providers';
import { SecretScrubber, openVault } from '@vc/secrets';
import { buildApp } from './app';
import { defaultRegistry, googleFonts, libraryMusic } from './catalogs';
import { openDb } from './db';
import { readEnv } from './env';
import { createServerMedia } from './media';
import { createRemotionRenderer } from './renderer';

const env = readEnv(process.env);
await mkdir(env.dataDir, { recursive: true, mode: 0o700 });
const db = openDb(join(env.dataDir, 'app.sqlite'));
const vault = await openVault({
  dataDir: env.dataDir,
  preferKeychain: env.preferKeychain,
  onFallback: (reason) =>
    process.stderr.write(`Key vault: ${reason} Using a passphrase-encrypted file instead.\n`),
});
const remotion = createRemotionRenderer({
  bundleDir: env.bundleDir,
  entryPoint: env.entryPoint,
  publicDir: env.publicDir,
});
const host = '127.0.0.1';
const origin = `http://${host}:${env.port}`;

const app = await buildApp({
  dataDir: env.dataDir,
  db,
  vault,
  scrubber: new SecretScrubber(),
  registry: defaultRegistry(),
  media: createServerMedia(),
  renderer: remotion,
  calibrator: remotion,
  imageSource: createOpenverseSource({}),
  pageFetcher: createPageFetcher(),
  fonts: googleFonts(),
  music: libraryMusic(env.dataDir),
  allowedHosts: [`127.0.0.1:${env.port}`, `localhost:${env.port}`, `[::1]:${env.port}`],
  allowedOrigins: [
    origin,
    `http://localhost:${env.port}`,
    ...(env.dev ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : []),
  ],
  publicOrigin: origin,
  webDistDir: env.webDistDir,
  platform: process.platform,
  cpuCount: availableParallelism(),
  now: () => new Date(),
  newId: () => randomUUID(),
  logger: { level: env.logLevel },
});

await app.listen({ host, port: env.port });
process.stdout.write(
  `\nVideo Creator is running at ${origin}\n${env.webDistDir ? '' : 'The web UI is not built: run `npm run build`, or use `npm run dev`.\n'}\n`,
);

const shutdown = () => {
  void app.close().finally(() => {
    db.close();
    process.exit(0);
  });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
