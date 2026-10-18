import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { JobFiles } from '@vc/pipeline';

export const jobDir = (dataDir: string, jobId: string) => join(dataDir, 'jobs', jobId);

/** The job folder and the shared cache folder on disk. */
export const jobFiles = (dataDir: string, jobId: string): JobFiles & { dir: string } => {
  const dir = jobDir(dataDir, jobId);
  const cacheDir = join(dataDir, 'cache', 'files');
  const inside = (base: string, name: string) => {
    const path = resolve(base, name);
    if (path !== base && !path.startsWith(base + sep))
      throw new Error(`Refusing to write outside ${base}: ${name}`);
    return path;
  };
  const ensure = async (path: string) => {
    await mkdir(dirname(path), { recursive: true });
    return path;
  };
  return {
    dir,
    pathFor: (name) => inside(dir, name),
    async write(name, data) {
      const path = await ensure(inside(dir, name));
      await writeFile(path, data);
      return path;
    },
    async read(path) {
      return new Uint8Array(await readFile(path));
    },
    async copyIn(sourcePath, name) {
      const path = await ensure(inside(dir, name));
      await copyFile(sourcePath, path);
      return path;
    },
    async writeCache(name, data) {
      const path = await ensure(inside(cacheDir, name));
      await writeFile(path, data);
      return path;
    },
    async exists(path) {
      return access(path).then(
        () => true,
        () => false,
      );
    },
  };
};

/** Resolves a URL path segment inside `base`, or null when it would escape it. */
export const safeJoin = (base: string, untrusted: string): string | null => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(untrusted);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const path = resolve(base, decoded);
  const rel = relative(base, path);
  // isAbsolute catches Windows paths on another drive, where relative() cannot be relative.
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? path : null;
};
