import { SCHEMA_DEFAULTS, mergeConfig } from '@vc/config';
import { describe, expect, it } from 'vitest';
import { calculateVideoMetadata } from './metadata';
import {
  captionBox,
  cardRect,
  duckedMusicVolume,
  letterboxBarHeight,
  motionBlurFor,
  speakingIntervals,
} from './layout';

describe('letterboxBarHeight', () => {
  it('computes cinema bars for each ratio', () => {
    expect(letterboxBarHeight(1920, 1080, '2.39:1')).toBe(138);
    expect(letterboxBarHeight(1920, 1080, '2:1')).toBe(60);
    expect(letterboxBarHeight(1920, 1080, '1.85:1')).toBe(21);
  });

  it('works on vertical frames too (the warning tells users it eats space)', () => {
    expect(letterboxBarHeight(1080, 1920, '2.39:1')).toBe(734);
  });

  it('returns 0 when the frame is already wider than the ratio', () => {
    expect(letterboxBarHeight(3000, 1000, '2:1')).toBe(0);
  });
});

describe('cardRect (soft card on the backdrop)', () => {
  it('leaves a caption band below the card on landscape frames', () => {
    const r = cardRect({ width: 1920, height: 1080, margin: 0.06, captionBand: 0.22 });
    expect(r.x).toBeGreaterThan(0);
    expect(r.y).toBeGreaterThan(0);
    expect(r.y + r.height).toBeLessThanOrEqual(1080 * (1 - 0.22) + 1);
    expect(r.x + r.width / 2).toBeCloseTo(960, 0);
  });

  it('keeps the card inside the frame for every aspect', () => {
    for (const [w, h] of [
      [1920, 1080],
      [1080, 1920],
      [1080, 1080],
    ] as const) {
      const r = cardRect({ width: w, height: h, margin: 0.1, captionBand: 0.2 });
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(w);
      expect(r.y + r.height).toBeLessThanOrEqual(h);
    }
  });
});

describe('captionBox', () => {
  const frame = { width: 1920, height: 1080 };

  it('places captions in the lower third, top or middle', () => {
    const bottom = captionBox({ ...frame, placement: 'bottom', mode: 'cover', letterbox: 0 });
    const top = captionBox({ ...frame, placement: 'top', mode: 'cover', letterbox: 0 });
    const middle = captionBox({ ...frame, placement: 'middle', mode: 'cover', letterbox: 0 });
    expect(bottom.y).toBeGreaterThan(1080 * 0.6);
    expect(top.y + top.height).toBeLessThan(1080 * 0.4);
    expect(middle.y).toBeGreaterThan(top.y + top.height);
    expect(bottom.width).toBeLessThan(1920);
  });

  it('always uses the band below the card in card mode', () => {
    const band = captionBox({ ...frame, placement: 'top', mode: 'card', letterbox: 0 });
    expect(band.y).toBeGreaterThan(1080 * 0.7);
  });

  it('keeps captions clear of letterbox bars', () => {
    const b = captionBox({ ...frame, placement: 'bottom', mode: 'cover', letterbox: 138 });
    expect(b.y + b.height).toBeLessThanOrEqual(1080 - 138);
  });
});

describe('preview ducking (the final mix uses ffmpeg sidechain compression)', () => {
  const words = [
    { text: 'a', startMs: 1000, endMs: 1400 },
    { text: 'b', startMs: 1500, endMs: 2000 },
    { text: 'c', startMs: 5000, endMs: 5500 },
  ];

  it('merges words separated by short pauses into speaking intervals', () => {
    expect(speakingIntervals(words, 250)).toEqual([
      { startMs: 1000, endMs: 2000 },
      { startMs: 5000, endMs: 5500 },
    ]);
  });

  it('lowers music by the ducking depth while speaking and restores it in silence', () => {
    const intervals = speakingIntervals(words, 250);
    const ducking = { enabled: true, depthDb: 12, attackMs: 30, releaseMs: 400 };
    const silent = duckedMusicVolume(0, intervals, 0.5, ducking);
    const speaking = duckedMusicVolume(1700, intervals, 0.5, ducking);
    expect(silent).toBeCloseTo(0.5, 6);
    expect(speaking).toBeCloseTo(0.5 * 10 ** (-12 / 20), 6);
    const releasing = duckedMusicVolume(2200, intervals, 0.5, ducking);
    expect(releasing).toBeGreaterThan(speaking);
    expect(releasing).toBeLessThan(silent);
    expect(duckedMusicVolume(3000, intervals, 0.5, ducking)).toBeCloseTo(0.5, 6);
  });

  it('leaves music alone when ducking is off', () => {
    expect(
      duckedMusicVolume(1700, speakingIntervals(words, 250), 0.3, {
        enabled: false,
        depthDb: 12,
        attackMs: 30,
        releaseMs: 400,
      }),
    ).toBe(0.3);
  });
});

describe('calculateVideoMetadata', () => {
  const plan = { durationMs: 10_010 };

  it('derives fps, frame size and duration from the config and plan', () => {
    const m = calculateVideoMetadata({
      config: mergeConfig(SCHEMA_DEFAULTS, { output: { fps: 24 }, simple: { aspect: '9:16' } }),
      plan,
    });
    expect(m).toEqual({ fps: 24, width: 1080, height: 1920, durationInFrames: 241 });
  });

  it('never returns zero frames', () => {
    expect(
      calculateVideoMetadata({ config: SCHEMA_DEFAULTS, plan: { durationMs: 1 } }).durationInFrames,
    ).toBe(1);
  });
});

describe('motionBlurFor: blur only images that move', () => {
  const blurOn = (imageMoves: Array<'push-in' | 'drift-lr' | 'none'>) =>
    mergeConfig(SCHEMA_DEFAULTS, {
      motion: { imageMoves, motionBlur: { enabled: true, samples: 6, shutterAngle: 90 } },
    });

  it('returns the configured samples and shutter for a moving image', () => {
    expect(motionBlurFor(blurOn(['push-in']), 0)).toEqual({ samples: 6, shutterAngle: 90 });
  });

  it('skips scenes whose image does not move: each sample re-renders the frame for nothing', () => {
    const config = blurOn(['push-in', 'none']);
    expect(motionBlurFor(config, 0)).not.toBeNull();
    expect(motionBlurFor(config, 1)).toBeNull();
    expect(motionBlurFor(config, 3)).toBeNull();
  });

  it('is off when motion blur is off', () => {
    expect(
      motionBlurFor(
        mergeConfig(blurOn(['push-in']), { motion: { motionBlur: { enabled: false } } }),
        0,
      ),
    ).toBeNull();
  });
});
