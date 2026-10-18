import { describe, expect, it } from 'vitest';
import { estimateJobCost, type EstimateProviders } from './cost-estimate';
import type { PriceLookup } from './ledger';

const prices: PriceLookup = (providerId) =>
  ({
    openai: {
      inputPerMTok: 2,
      outputPerMTok: 8,
      perSearch: 0.01,
      perMChars: 15,
      perAudioMinute: 0.006,
      perImage: 0,
    },
    elevenlabs: { perMChars: 200 },
    brave: { perSearch: 0.005 },
    ollama: {},
    kokoro: {},
    'whisper-cpp': {},
  })[providerId] ?? null;

const cloud: EstimateProviders = {
  text: { providerId: 'openai', model: 'gpt' },
  search: { providerId: 'brave', model: null, usesModel: false },
  voice: { providerId: 'openai', model: 'tts', returnsTimings: false },
  align: { providerId: 'openai', model: 'whisper-1' },
  vision: { providerId: 'openai', model: 'gpt' },
};

const base = {
  lengthSeconds: 60,
  animationKind: 'documentary' as const,
  providers: cloud,
  prices,
  sourceTextProvided: false,
  recordingProvided: false,
  visionAlways: false,
  visionFinalCheck: false,
};

const stages = (r: ReturnType<typeof estimateJobCost>) =>
  r.lines.map((l) => `${l.stage}:${l.role}`);

describe('estimateJobCost (shown before Generate)', () => {
  it('covers research, script, voice, alignment and expected vision ranking', () => {
    const r = estimateJobCost(base);
    expect(stages(r)).toEqual([
      'research:search',
      'research:text',
      'script:text',
      'voice:voice',
      'timing:align',
      'images:vision',
    ]);
    expect(r.totalUsd).toBeGreaterThan(0);
    expect(r.maxUsd).toBeGreaterThan(r.totalUsd);
  });

  it('skips research when source text is pasted', () => {
    expect(stages(estimateJobCost({ ...base, sourceTextProvided: true }))).not.toContain(
      'research:text',
    );
  });

  it('skips TTS for an uploaded recording but keeps alignment', () => {
    const s = stages(estimateJobCost({ ...base, recordingProvided: true }));
    expect(s).not.toContain('voice:voice');
    expect(s).toContain('timing:align');
  });

  it('skips alignment when the voice returns timings', () => {
    const r = estimateJobCost({
      ...base,
      providers: {
        ...cloud,
        voice: { providerId: 'elevenlabs', model: 'm', returnsTimings: true },
      },
    });
    expect(stages(r)).not.toContain('timing:align');
  });

  it('prices TTS by characters (about six per word at 150 words a minute)', () => {
    const r = estimateJobCost({
      ...base,
      providers: {
        ...cloud,
        voice: { providerId: 'elevenlabs', model: 'm', returnsTimings: true },
      },
    });
    const voice = r.lines.find((l) => l.role === 'voice')!;
    expect(voice.units.characters).toBe(900);
    expect(voice.usd).toBeCloseTo(0.18, 6);
  });

  it('assumes vision on every scene when it is always on, and adds the frame check', () => {
    const sometimes = estimateJobCost(base).lines.find((l) => l.role === 'vision')!;
    const always = estimateJobCost({ ...base, visionAlways: true, visionFinalCheck: true });
    const ranking = always.lines.find((l) => l.stage === 'images')!;
    expect(ranking.units.images!).toBeGreaterThan(sometimes.units.images!);
    expect(always.lines.some((l) => l.stage === 'checks')).toBe(true);
  });

  it('has no vision lines when vision is off', () => {
    expect(
      estimateJobCost({ ...base, providers: { ...cloud, vision: null } }).lines.some(
        (l) => l.role === 'vision',
      ),
    ).toBe(false);
  });

  it('costs nothing with local providers', () => {
    const local: EstimateProviders = {
      text: { providerId: 'ollama', model: 'llama' },
      search: null,
      voice: { providerId: 'kokoro', model: 'k', returnsTimings: false },
      align: { providerId: 'whisper-cpp', model: 'base.en' },
      vision: null,
    };
    const r = estimateJobCost({ ...base, providers: local, sourceTextProvided: true });
    expect(r.totalUsd).toBe(0);
    expect(r.maxUsd).toBe(0);
    expect(r.unpriced).toEqual([]);
  });

  it('flags providers whose prices are unknown', () => {
    const r = estimateJobCost({
      ...base,
      providers: { ...cloud, text: { providerId: 'mystery', model: 'x' } },
    });
    expect(r.unpriced).toEqual(['mystery/x']);
  });

  it('includes the one allowed script retry in the maximum', () => {
    const r = estimateJobCost(base);
    const script = r.lines.find((l) => l.stage === 'script')!;
    expect(script.maxUsd).toBeCloseTo(script.usd * 2, 10);
  });
});
