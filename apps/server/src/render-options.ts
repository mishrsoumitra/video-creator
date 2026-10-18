import { resolutionScale, type VideoConfig } from '@vc/config';

export type RenderOptions = {
  codec: VideoConfig['output']['codec'];
  crf?: number;
  imageFormat: 'jpeg' | 'png';
  jpegQuality?: number;
  pixelFormat: VideoConfig['output']['pixelFormat'];
  colorSpace: VideoConfig['output']['colorSpace'];
  x264Preset?: NonNullable<VideoConfig['output']['x264Preset']>;
  proResProfile?: VideoConfig['output']['proResProfile'];
  hardwareAcceleration: VideoConfig['output']['hardwareAcceleration'];
  concurrency?: number | string;
  scale: number;
  muted: true;
  enforceAudioTrack: false;
};

/**
 * The renderMedia() options for a config. The video is rendered muted: narration and music are
 * mixed, ducked and loudness-normalised by ffmpeg and muxed in afterwards.
 */
export const renderOptionsFor = (config: VideoConfig): RenderOptions => {
  const o = config.output;
  return {
    codec: o.codec,
    ...(o.crf !== null ? { crf: o.crf } : {}),
    imageFormat: o.imageFormat,
    ...(o.imageFormat === 'jpeg' ? { jpegQuality: o.jpegQuality } : {}),
    pixelFormat: o.pixelFormat,
    colorSpace: o.colorSpace,
    ...(o.codec === 'h264' && o.x264Preset ? { x264Preset: o.x264Preset } : {}),
    ...(o.codec === 'prores' ? { proResProfile: o.proResProfile } : {}),
    hardwareAcceleration: o.hardwareAcceleration,
    ...(o.concurrency !== null ? { concurrency: o.concurrency } : {}),
    scale: resolutionScale(o.resolution),
    muted: true,
    enforceAudioTrack: false,
  };
};
