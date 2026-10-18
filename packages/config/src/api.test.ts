import { describe, expect, it } from 'vitest';
import {
  EstimateRequestSchema,
  PutSettingsSchema,
  SettingsSchema,
  isRoleId,
  musicPreviewUrl,
} from './api';

describe('settings schemas', () => {
  it('fills defaults for a fresh install', () => {
    expect(SettingsSchema.parse({})).toEqual({
      costCapUsd: 2,
      visionRankAlways: false,
      visionFinalCheck: false,
      pricingOverrides: {},
      defaultPresetId: 'documentary',
    });
  });

  it('keeps a partial update partial: omitted keys must not come back as defaults', () => {
    expect(PutSettingsSchema.parse({})).toEqual({});
    expect(PutSettingsSchema.parse({ visionRankAlways: true })).toEqual({ visionRankAlways: true });
  });

  it('validates what it is sent, and refuses unknown keys', () => {
    expect(PutSettingsSchema.safeParse({ costCapUsd: -1 }).success).toBe(false);
    expect(PutSettingsSchema.safeParse({ costCapUsd: 1001 }).success).toBe(false);
    expect(PutSettingsSchema.safeParse({ apiKey: 'sk-x' }).success).toBe(false);
  });
});

describe('estimate request', () => {
  it('limits the length to 15 s – 10 min', () => {
    expect(EstimateRequestSchema.shape.lengthSeconds.safeParse(14).success).toBe(false);
    expect(EstimateRequestSchema.shape.lengthSeconds.safeParse(600).success).toBe(true);
    expect(EstimateRequestSchema.shape.lengthSeconds.safeParse(601).success).toBe(false);
  });
});

describe('helpers', () => {
  it('builds the library music preview URL', () => {
    expect(musicPreviewUrl('soft-pad', 12_345.6)).toBe('/api/music/soft-pad?durationMs=12346');
    expect(musicPreviewUrl('a b', 1000)).toBe('/api/music/a%20b?durationMs=1000');
  });

  it('recognises role ids', () => {
    expect(isRoleId('voice')).toBe(true);
    expect(isRoleId('music')).toBe(false);
  });
});
