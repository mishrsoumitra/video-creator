/**
 * The real app with fake AI providers: real ffmpeg, Remotion, fonts and music, but no keys and no
 * cost. For trying the UI end to end and for demos. Narration is silent (the fake voice).
 *   npm run demo           # then open the printed URL; use the printed key for "Acme AI"
 */
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { candidate, FakeImageSource } from '@vc/pipeline/testing';
import { createSafeDownloader } from '@vc/providers';
import { SecretScrubber } from '@vc/secrets';
import { writeSolidImage } from '@vc/media/testing';
import { runFfmpeg } from '@vc/media';
import { buildApp } from '../src/app';
import { googleFonts, libraryMusic } from '../src/catalogs';
import { openDb } from '../src/db';
import { readEnv } from '../src/env';
import { createServerMedia } from '../src/media';
import { createRemotionRenderer } from '../src/renderer';
import { ACME_KEY, LockableVault, fakePageFetcher, fakeRegistry } from '../src/test/fakes';

const env = readEnv({
  ...process.env,
  VC_PORT: process.env.VC_PORT ?? '4318',
  VC_DATA_DIR: process.env.VC_DATA_DIR ?? join(process.cwd(), '.vc-data', 'demo'),
});
await mkdir(env.dataDir, { recursive: true });

// Synthetic, licence-free images served from a local port, standing in for Openverse.
const imageDir = join(env.dataDir, 'demo-images');
await mkdir(imageDir, { recursive: true });
const images: Array<[string, () => Promise<unknown>]> = [
  [
    'gradient.jpg',
    () =>
      runFfmpeg(
        [
          '-y',
          '-f',
          'lavfi',
          '-i',
          'gradients=s=1920x1080:c0=0x1c1f2a:c1=0xf5b700:c2=0x4c8dff:nb_colors=3:duration=1:speed=0',
          '-frames:v',
          '1',
          join(imageDir, 'gradient.jpg'),
        ],
        {},
      ),
  ],
  [
    'fractal.jpg',
    () =>
      runFfmpeg(
        [
          '-y',
          '-f',
          'lavfi',
          '-i',
          'mandelbrot=s=1600x1200:maxiter=200',
          '-frames:v',
          '1',
          join(imageDir, 'fractal.jpg'),
        ],
        {},
      ),
  ],
  [
    'teal.jpg',
    () =>
      writeSolidImage({
        path: join(imageDir, 'teal.jpg'),
        width: 1920,
        height: 1080,
        color: '#0f766e',
      }),
  ],
];
for (const [, make] of images) await make();
const imageServer = createServer((req, res) => {
  const name = (req.url ?? '').slice(1);
  if (!images.some(([n]) => n === name)) {
    res.writeHead(404).end();
    return;
  }
  void readFile(join(imageDir, name)).then((data) =>
    res.writeHead(200, { 'content-type': 'image/jpeg' }).end(data),
  );
});
await new Promise<void>((resolve) => imageServer.listen(0, '127.0.0.1', resolve));
const imagePort = (imageServer.address() as AddressInfo).port;
let n = 0;

const origin = `http://127.0.0.1:${env.port}`;
const db = openDb(join(env.dataDir, 'app.sqlite'));
const renderer = createRemotionRenderer({
  bundleDir: env.bundleDir,
  entryPoint: env.entryPoint,
  publicDir: env.publicDir,
});
const app = await buildApp({
  dataDir: env.dataDir,
  db,
  vault: new LockableVault(),
  scrubber: new SecretScrubber(),
  registry: fakeRegistry(),
  media: createServerMedia({
    downloader: createSafeDownloader({
      lookup: async () => [{ address: '127.0.0.1', family: 4 }],
      isAddressAllowed: () => true,
    }),
  }),
  renderer,
  calibrator: renderer,
  imageSource: new FakeImageSource((q) =>
    images.map(([name], i) =>
      candidate({
        id: `${q.query}-${i}`,
        title: `${q.query} ${name}`,
        tags: q.query.split(' '),
        url: `http://demo-images.test:${imagePort}/${images[(n++ + i) % images.length]![0]}`,
        width: 1920,
        height: 1080,
      }),
    ),
  ),
  pageFetcher: fakePageFetcher(),
  fonts: googleFonts(),
  music: libraryMusic(env.dataDir),
  allowedHosts: [`127.0.0.1:${env.port}`, `localhost:${env.port}`],
  allowedOrigins: [
    origin,
    `http://localhost:${env.port}`,
    'http://localhost:5173',
    'http://127.0.0.1:5173',
  ],
  publicOrigin: origin,
  webDistDir: env.webDistDir,
  platform: process.platform,
  cpuCount: availableParallelism(),
  now: () => new Date(),
  newId: () => `demo-${Date.now().toString(36)}`,
  logger: { level: 'warn' },
});
await app.listen({ host: '127.0.0.1', port: env.port });
process.stdout.write(
  `\nDemo server (fake AI, real rendering): ${origin}\nIn Setup choose "Acme AI" for every role and use the key: ${ACME_KEY}\nData: ${env.dataDir}\n\n`,
);
