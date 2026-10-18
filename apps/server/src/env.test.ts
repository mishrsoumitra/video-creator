import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readEnv } from './env';

const dirs: string[] = [];
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

describe('server environment', () => {
  it('defaults to port 4317, ~/.video-creator, the OS keychain and info logs', () => {
    const env = readEnv({});
    expect(env).toMatchObject({
      port: 4317,
      dataDir: join(homedir(), '.video-creator'),
      dev: false,
      logLevel: 'info',
      preferKeychain: true,
    });
    expect(env.entryPoint).toMatch(/packages\/composition\/src\/entry\.ts$/);
    expect(env.publicDir).toMatch(/packages\/composition\/public$/);
  });

  it('treats an empty VC_PORT as unset', () => {
    expect(readEnv({ VC_PORT: '' }).port).toBe(4317);
    expect(readEnv({ VC_PORT: ' 8080 ' }).port).toBe(8080);
  });

  it.each(['0', '65536', '-1', '43.5', 'abc', '1e3x'])('rejects VC_PORT=%s', (port) => {
    expect(() => readEnv({ VC_PORT: port })).toThrow(/VC_PORT must be a port number/);
  });

  it('reads overrides, and resolves relative and ~ data directories to absolute paths', () => {
    expect(
      readEnv({ VC_PORT: '8080', VC_DEV: '1', VC_LOG_LEVEL: 'warn', VC_KEYCHAIN: '0' }),
    ).toMatchObject({ port: 8080, dev: true, logLevel: 'warn', preferKeychain: false });
    expect(readEnv({ VC_DATA_DIR: 'data/vc' }).dataDir).toBe(resolve('data/vc'));
    expect(readEnv({ VC_DATA_DIR: '~/vc-data' }).dataDir).toBe(join(homedir(), 'vc-data'));
    expect(readEnv({ VC_DATA_DIR: '/srv/vc' }).dataDir).toBe('/srv/vc');
  });

  it('uses the built web UI and Remotion bundle only once they exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vc-env-'));
    dirs.push(dir);
    const web = join(dir, 'web');
    const bundle = join(dir, 'bundle');
    await mkdir(web);
    await mkdir(bundle);
    expect(readEnv({ VC_WEB_DIST: web, VC_REMOTION_BUNDLE: bundle })).toMatchObject({
      webDistDir: null,
      bundleDir: null,
    });
    await writeFile(join(web, 'index.html'), '<!doctype html>');
    await writeFile(join(bundle, 'index.html'), '<!doctype html>');
    expect(readEnv({ VC_WEB_DIST: web, VC_REMOTION_BUNDLE: bundle })).toMatchObject({
      webDistDir: web,
      bundleDir: bundle,
    });
  });
});
