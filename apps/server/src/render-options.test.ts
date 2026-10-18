import { SCHEMA_DEFAULTS, mergeConfig, type VideoConfigInput } from '@vc/config';
import { describe, expect, it } from 'vitest';
import { renderOptionsFor } from './render-options';

const opts = (output: VideoConfigInput['output']) =>
  renderOptionsFor(mergeConfig(SCHEMA_DEFAULTS, { output }));

describe('renderOptionsFor: config.output → Remotion renderMedia() options', () => {
  it('maps the defaults: h264, codec-default CRF, 1080p, muted (ffmpeg mixes the audio)', () => {
    expect(opts({})).toEqual({
      codec: 'h264',
      imageFormat: 'jpeg',
      jpegQuality: 80,
      pixelFormat: 'yuv420p',
      colorSpace: 'default',
      hardwareAcceleration: 'disable',
      scale: 1,
      muted: true,
      enforceAudioTrack: false,
    });
  });

  it('passes an explicit CRF and leaves it out when null', () => {
    expect(opts({ crf: 22 }).crf).toBe(22);
    expect('crf' in opts({ crf: null })).toBe(false);
  });

  it('only passes the x264 preset for h264 and the ProRes profile for ProRes', () => {
    expect(opts({ x264Preset: 'slow' }).x264Preset).toBe('slow');
    expect(opts({ codec: 'prores', proResProfile: '4444' })).toMatchObject({
      codec: 'prores',
      proResProfile: '4444',
    });
    expect('proResProfile' in opts({})).toBe(false);
    expect('x264Preset' in opts({ codec: 'vp9' })).toBe(false);
  });

  it('uses Remotion scale for 720p and 4K', () => {
    expect(opts({ resolution: '720p' }).scale).toBeCloseTo(2 / 3, 10);
    expect(opts({ resolution: '4k' }).scale).toBe(2);
  });

  it('drops JPEG quality for PNG frames', () => {
    const png = opts({ imageFormat: 'png' });
    expect(png.imageFormat).toBe('png');
    expect('jpegQuality' in png).toBe(false);
  });

  it('passes concurrency and hardware acceleration through', () => {
    expect(opts({ concurrency: '50%', hardwareAcceleration: 'if-possible' })).toMatchObject({
      concurrency: '50%',
      hardwareAcceleration: 'if-possible',
    });
    expect('concurrency' in opts({ concurrency: null })).toBe(false);
  });
});
