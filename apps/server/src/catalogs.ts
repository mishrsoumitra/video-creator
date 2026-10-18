import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getAvailableFonts } from '@remotion/google-fonts';
import type { FontInfo } from '@vc/config';
import { LIBRARY_TRACKS, generateLibraryTrack, type LibraryTrackId } from '@vc/media';
import { PROVIDERS, createRoleProvider } from '@vc/providers';
import type { FontCatalog, MusicLibrary, ProviderRegistry } from './services';

/** Every Google Font Remotion knows; FontInfo is loaded lazily per family. */
export const googleFonts = (): FontCatalog => {
  let all: ReturnType<typeof getAvailableFonts> | null = null;
  const list = () => (all ??= getAvailableFonts());
  return {
    families: async () => list().map((f) => f.fontFamily),
    info: async (family) => {
      const entry = list().find((f) => f.fontFamily === family);
      if (!entry) return null;
      return (await entry.load()).getInfo() as unknown as FontInfo;
    },
  };
};

/** Procedural library tracks, generated once per length and cached. */
export const libraryMusic = (dataDir: string): MusicLibrary => {
  const dir = join(dataDir, 'cache', 'music');
  const inflight = new Map<string, Promise<string>>();
  return {
    tracks: LIBRARY_TRACKS.map(({ id, label, mood }) => ({ id, label, mood })),
    pathFor(trackId, durationMs) {
      const path = join(dir, `${trackId}-${Math.round(durationMs)}.wav`);
      const pending = inflight.get(path);
      if (pending) return pending;
      const work = (async () => {
        try {
          await access(path);
          return path;
        } catch {
          await mkdir(dir, { recursive: true });
          await generateLibraryTrack(trackId as LibraryTrackId, Math.round(durationMs), path);
          return path;
        }
      })().finally(() => inflight.delete(path));
      inflight.set(path, work);
      return work;
    },
  };
};

export const defaultRegistry = (): ProviderRegistry => ({
  list: () => [...PROVIDERS],
  get: (id) => PROVIDERS.find((p) => p.id === id),
  create: (input) => createRoleProvider(input),
});
