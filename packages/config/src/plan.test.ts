import { describe, expect, it } from 'vitest';
import {
  JobRequestSchema,
  LENGTH_PRESETS_SECONDS,
  SCHEMA_DEFAULTS,
  ScenePlanSchema,
  type ScenePlan,
} from './index';

const plan = (): ScenePlan => ({
  version: 1,
  title: 'Apollo',
  durationMs: 6000,
  scenes: [
    {
      id: 's1',
      startMs: 0,
      endMs: 3000,
      narration: 'The Apollo program.',
      visual: {
        type: 'image',
        src: 'http://127.0.0.1:4317/api/jobs/j1/assets/s1.jpg',
        width: 1920,
        height: 1080,
        credit: {
          title: 'Saturn V',
          creator: 'NASA',
          license: 'pdm',
          licenseVersion: null,
          licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/',
          sourceUrl: 'https://example.org/1',
          provider: 'openverse',
        },
      },
      captionPlacement: 'bottom',
    },
    {
      id: 's2',
      startMs: 3000,
      endMs: 6000,
      narration: 'Twelve people walked on the Moon.',
      visual: { type: 'typographic', text: 'Twelve people' },
      captionPlacement: 'bottom',
    },
  ],
  words: [
    { text: 'The', startMs: 0, endMs: 200 },
    { text: 'Apollo', startMs: 220, endMs: 600 },
  ],
  audio: { narrationSrc: 'http://127.0.0.1:4317/api/jobs/j1/assets/narration.wav', musicSrc: null },
  palette: null,
  fonts: { caption: null },
});

describe('ScenePlanSchema (the composition’s data props)', () => {
  it('accepts a well-formed plan', () => {
    expect(ScenePlanSchema.parse(plan())).toEqual(plan());
  });

  it('requires contiguous scenes from 0 to the end of the narration', () => {
    const gap = plan();
    gap.scenes[1]!.startMs = 3100;
    expect(ScenePlanSchema.safeParse(gap).success).toBe(false);
    const short = plan();
    short.durationMs = 5000;
    expect(ScenePlanSchema.safeParse(short).success).toBe(false);
  });

  it('requires image visuals to carry dimensions and typographic ones to carry text', () => {
    const noDims = plan() as unknown as { scenes: Array<{ visual: Record<string, unknown> }> };
    delete noDims.scenes[0]!.visual.width;
    expect(ScenePlanSchema.safeParse(noDims).success).toBe(false);
    const noText = plan();
    noText.scenes[1]!.visual = { type: 'typographic', text: '' };
    expect(ScenePlanSchema.safeParse(noText).success).toBe(false);
  });

  it('allows an audio tail after the last scene boundary is reached', () => {
    const tail = plan();
    tail.durationMs = 6400;
    expect(ScenePlanSchema.safeParse(tail).success).toBe(true);
  });
});

describe('JobRequestSchema (the API request)', () => {
  const base = { topic: 'The Apollo program', lengthSeconds: 60, config: SCHEMA_DEFAULTS };

  it('accepts a minimal request', () => {
    expect(JobRequestSchema.parse(base)).toMatchObject({
      topic: 'The Apollo program',
      lengthSeconds: 60,
    });
  });

  it('accepts every length button', () => {
    for (const lengthSeconds of LENGTH_PRESETS_SECONDS) {
      expect(JobRequestSchema.safeParse({ ...base, lengthSeconds }).success).toBe(true);
    }
  });

  it.each([
    [{ topic: '  ab  ' }, 'topic'],
    [{ topic: 'x'.repeat(201) }, 'topic'],
    [{ lengthSeconds: 14 }, 'lengthSeconds'],
    [{ lengthSeconds: 601 }, 'lengthSeconds'],
    [{ lengthSeconds: 60.5 }, 'lengthSeconds'],
    [{ sourceText: 'x'.repeat(100_001) }, 'sourceText'],
  ])('rejects %j', (patch, path) => {
    const result = JobRequestSchema.safeParse({ ...base, ...patch });
    expect(result.success).toBe(false);
    expect(result.error!.issues[0]!.path[0]).toBe(path);
  });

  it('trims the topic', () => {
    expect(JobRequestSchema.parse({ ...base, topic: '  Volcanoes  ' }).topic).toBe('Volcanoes');
  });

  it('accepts a preset reference instead of a full config', () => {
    const { config: _config, ...rest } = base;
    expect(
      JobRequestSchema.safeParse({
        ...rest,
        presetId: 'documentary',
        overrides: { output: { fps: 60 } },
      }).success,
    ).toBe(true);
  });

  it('treats blank source text as absent', () => {
    expect(JobRequestSchema.parse({ ...base, sourceText: '   ' }).sourceText).toBeUndefined();
  });
});
