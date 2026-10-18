import { describe, expect, it } from 'vitest';
import {
  LIBRARY_TRACKS,
  buildConcatList,
  buildMixGraph,
  duckingThreshold,
  parseFfmpegVersion,
  parseLoudnormJson,
  selectFrameNumbers,
  trackSources,
} from './index';

describe('duckingThreshold (depthDb → sidechaincompress threshold)', () => {
  it('maps the requested depth through the calibrated key level and ratio 20', () => {
    // threshold dB = -0.95 - depth / (1 - 1/20)
    expect(duckingThreshold(12)).toBeCloseTo(10 ** ((-0.95 - 12 / 0.95) / 20), 12);
    expect(duckingThreshold(6)).toBeCloseTo(10 ** ((-0.95 - 6 / 0.95) / 20), 12);
  });

  it('gets lower (ducks harder) as the depth grows', () => {
    expect(duckingThreshold(20)).toBeLessThan(duckingThreshold(10));
  });

  it('stays inside the range ffmpeg accepts', () => {
    expect(duckingThreshold(30)).toBeGreaterThanOrEqual(0.000976563);
    expect(duckingThreshold(0.1)).toBeLessThanOrEqual(1);
  });
});

const base = {
  musicPresent: true,
  narrationVolume: 1,
  narrationRate: 1,
  musicVolume: 0.25,
  ducking: { enabled: true, depthDb: 12, attackMs: 30, releaseMs: 400 },
  durationSeconds: 10,
  fadeInSeconds: 0.5,
  fadeOutSeconds: 1,
};

describe('buildMixGraph', () => {
  it('keys a sidechain compressor on the narration and mixes without normalising', () => {
    const graph = buildMixGraph(base);
    expect(graph).toContain('sidechaincompress=');
    expect(graph).toContain(`threshold=${duckingThreshold(12).toFixed(6)}`);
    expect(graph).toContain('ratio=20');
    expect(graph).toContain('attack=30');
    expect(graph).toContain('release=400');
    expect(graph).toContain('amix=inputs=2:duration=first:dropout_transition=0:normalize=0');
    expect(graph).toContain('atrim=duration=10.000000');
    expect(graph).toContain('volume=0.250000');
    expect(graph.endsWith('[out]')).toBe(true);
  });

  it('skips the compressor when ducking is off or zero dB deep', () => {
    expect(buildMixGraph({ ...base, ducking: { ...base.ducking, enabled: false } })).not.toContain(
      'sidechaincompress',
    );
    expect(buildMixGraph({ ...base, ducking: { ...base.ducking, depthDb: 0 } })).not.toContain(
      'sidechaincompress',
    );
  });

  it('leaves out the music branch when there is no music', () => {
    const graph = buildMixGraph({ ...base, musicPresent: false });
    expect(graph).not.toContain('[1:a]');
    expect(graph).not.toContain('amix');
    expect(graph.endsWith('[out]')).toBe(true);
  });

  it('retimes the narration with atempo only when the rate changes', () => {
    expect(buildMixGraph(base)).not.toContain('atempo');
    expect(buildMixGraph({ ...base, narrationRate: 1.25 })).toContain('atempo=1.250000');
  });

  it('fades the music in and out inside the narration length', () => {
    const graph = buildMixGraph(base);
    expect(graph).toContain('afade=t=in:st=0:d=0.500000');
    expect(graph).toContain('afade=t=out:st=9.000000:d=1.000000');
  });
});

describe('buildConcatList', () => {
  it('escapes single quotes in paths for the concat demuxer', () => {
    expect(buildConcatList(['/tmp/a.mp4', "/tmp/it's here.mp4"])).toBe(
      "file '/tmp/a.mp4'\nfile '/tmp/it'\\''s here.mp4'\n",
    );
  });

  it('refuses an empty list', () => {
    expect(() => buildConcatList([])).toThrow(/at least one/i);
  });
});

describe('selectFrameNumbers', () => {
  it('spreads the picks evenly across the video', () => {
    expect(selectFrameNumbers(120, 12)).toEqual([5, 15, 25, 35, 45, 55, 65, 75, 85, 95, 105, 115]);
  });

  it('returns every frame when the video is shorter than the request', () => {
    expect(selectFrameNumbers(5, 12)).toEqual([0, 1, 2, 3, 4]);
  });

  it('returns unique, increasing frame numbers within range', () => {
    for (const total of [1, 2, 13, 97, 1000]) {
      const picks = selectFrameNumbers(total, 12);
      expect(new Set(picks).size).toBe(picks.length);
      expect(picks.every((n, i) => n >= 0 && n < total && (i === 0 || n > picks[i - 1]!))).toBe(
        true,
      );
    }
  });
});

describe('parseLoudnormJson', () => {
  const stderr = `[Parsed_loudnorm_0 @ 0x1] \n{\n\t"input_i" : "-21.97",\n\t"input_tp" : "-15.96",\n\t"input_lra" : "1.00",\n\t"input_thresh" : "-32.07",\n\t"output_i" : "-16.11",\n\t"output_tp" : "-10.18",\n\t"output_lra" : "0.60",\n\t"output_thresh" : "-26.19",\n\t"normalization_type" : "dynamic",\n\t"target_offset" : "0.11"\n}\n`;

  it('reads the JSON block loudnorm prints at the end of stderr', () => {
    expect(parseLoudnormJson(stderr)).toMatchObject({
      inputI: -21.97,
      inputTp: -15.96,
      inputLra: 1,
      inputThresh: -32.07,
      outputI: -16.11,
      normalizationType: 'dynamic',
      targetOffset: 0.11,
    });
  });

  it('turns "-inf" into -Infinity (digital silence)', () => {
    expect(parseLoudnormJson(stderr.replace('"-21.97"', '"-inf"')).inputI).toBe(
      Number.NEGATIVE_INFINITY,
    );
  });

  it('throws when there is no JSON', () => {
    expect(() => parseLoudnormJson('no stats here')).toThrow();
  });
});

describe('parseFfmpegVersion', () => {
  it('reads release and git versions', () => {
    expect(
      parseFfmpegVersion('ffmpeg version 9.0.2 Copyright (c) 2000-2026 the FFmpeg developers'),
    ).toBe('9.0.2');
    expect(parseFfmpegVersion('ffmpeg version n7.1-12-gabc Copyright')).toBe('n7.1-12-gabc');
    expect(parseFfmpegVersion('garbage')).toBeNull();
  });
});

describe('library tracks', () => {
  it('offers three original tracks', () => {
    expect(LIBRARY_TRACKS.map((t) => t.id)).toEqual(['soft-pad', 'pulse', 'drone']);
    for (const t of LIBRARY_TRACKS) expect(t.label.length).toBeGreaterThan(0);
  });

  it('builds each track from lavfi sources with the requested duration', () => {
    for (const t of LIBRARY_TRACKS) {
      const { inputs, filter } = trackSources(t.id, 12.5);
      expect(inputs.length).toBeGreaterThan(0);
      expect(inputs.every((i) => i.includes('d=12.500000'))).toBe(true);
      expect(filter.length).toBeGreaterThan(0);
    }
  });
});
