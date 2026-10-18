import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ServerEnv = {
  port: number;
  dataDir: string;
  webDistDir: string | null;
  bundleDir: string | null;
  entryPoint: string;
  publicDir: string;
  dev: boolean;
  logLevel: string;
  preferKeychain: boolean;
};

/** apps/server/src (dev, tsx) and apps/server/dist (built) are both three levels below the repo. */
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

/** Absolute, with a leading ~ expanded: static file serving needs absolute roots. */
const absolutePath = (path: string) =>
  path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : resolve(path);
/** Unset and empty are the same thing (a blank line in an env file). */
const setting = (value: string | undefined) => (value?.trim() ? value.trim() : undefined);

export const readEnv = (env: NodeJS.ProcessEnv): ServerEnv => {
  const rawPort = setting(env.VC_PORT) ?? '4317';
  const port = /^\d+$/.test(rawPort) ? Number(rawPort) : Number.NaN;
  if (!(port >= 1 && port <= 65_535))
    throw new Error(`VC_PORT must be a port number, got "${env.VC_PORT}".`);
  const webDist = absolutePath(setting(env.VC_WEB_DIST) ?? join(repoRoot, 'apps/web/dist'));
  const bundle = absolutePath(
    setting(env.VC_REMOTION_BUNDLE) ?? join(repoRoot, 'packages/composition/build'),
  );
  return {
    port,
    dataDir: absolutePath(setting(env.VC_DATA_DIR) ?? join(homedir(), '.video-creator')),
    webDistDir: existsSync(join(webDist, 'index.html')) ? webDist : null,
    bundleDir: existsSync(join(bundle, 'index.html')) ? bundle : null,
    entryPoint: join(repoRoot, 'packages/composition/src/entry.ts'),
    publicDir: join(repoRoot, 'packages/composition/public'),
    dev: env.VC_DEV === '1',
    logLevel: setting(env.VC_LOG_LEVEL) ?? 'info',
    preferKeychain: env.VC_KEYCHAIN !== '0',
  };
};
