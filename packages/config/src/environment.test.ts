import { describe, expect, it } from 'vitest';
import {
  SCHEMA_DEFAULTS,
  mergeConfig,
  validateForEnvironment,
  type VideoConfigInput,
} from './index';

const baseEnv = {
  platform: 'darwin' as NodeJS.Platform,
  cpuCount: 8,
  fontFamilies: new Set(['Inter', 'Roboto', 'Playfair Display']),
  musicTracks: new Set(['soft-pad', 'pulse', 'drone']),
  uploads: new Set(['upl_music_1']),
};

const check = (patch: VideoConfigInput, env: Partial<typeof baseEnv> = {}) =>
  validateForEnvironment(mergeConfig(SCHEMA_DEFAULTS, patch), { ...baseEnv, ...env }).map(
    (i) => i.path,
  );

describe('validateForEnvironment (checks the schema cannot make on its own)', () => {
  it('passes the defaults', () => {
    expect(check({})).toEqual([]);
  });

  it('refuses required hardware ProRes off macOS', () => {
    const patch: VideoConfigInput = {
      output: { codec: 'prores', hardwareAcceleration: 'required' },
    };
    expect(check(patch, { platform: 'linux' })).toEqual(['output.hardwareAcceleration']);
    expect(check(patch, { platform: 'darwin' })).toEqual([]);
  });

  it('refuses concurrency above the number of cores, or a percentage that resolves to zero', () => {
    expect(check({ output: { concurrency: 16 } })).toEqual(['output.concurrency']);
    expect(check({ output: { concurrency: 8 } })).toEqual([]);
    expect(check({ output: { concurrency: '5%' } }, { cpuCount: 8 })).toEqual([
      'output.concurrency',
    ]);
    expect(check({ output: { concurrency: '100%' } })).toEqual([]);
  });

  it('refuses a font that is not in the Google Fonts catalog', () => {
    expect(check({ captions: { fontFamily: 'Comic Neue Ultra' } })).toEqual([
      'captions.fontFamily',
    ]);
    expect(check({ captions: { fontFamily: 'Playfair Display' } })).toEqual([]);
  });

  it('refuses an unknown library track or a missing upload', () => {
    expect(check({ audio: { music: { source: 'library', trackId: 'nope' } } })).toEqual([
      'audio.music.trackId',
    ]);
    expect(
      check({ audio: { music: { source: 'upload', uploadId: 'upl_missing', trackId: null } } }),
    ).toEqual(['audio.music.uploadId']);
    expect(
      check({ audio: { music: { source: 'upload', uploadId: 'upl_music_1', trackId: null } } }),
    ).toEqual([]);
  });

  it('skips catalog checks it has no data for', () => {
    const config = mergeConfig(SCHEMA_DEFAULTS, { captions: { fontFamily: 'Anything' } });
    expect(validateForEnvironment(config, { platform: 'darwin', cpuCount: 8 })).toEqual([]);
  });
});
