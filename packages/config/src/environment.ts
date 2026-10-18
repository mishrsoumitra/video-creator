import { supportsHardwareAcceleration } from './codecs';
import type { FieldError } from './expert';
import { resolveConcurrency } from './render-estimate';
import type { VideoConfig } from './schema';

export type EnvironmentInfo = {
  platform: NodeJS.Platform;
  cpuCount: number;
  /** Google Fonts families; omitted = not checked. */
  fontFamilies?: ReadonlySet<string>;
  musicTracks?: ReadonlySet<string>;
  uploads?: ReadonlySet<string>;
};

/** Checks that depend on the machine and local data, which the schema alone cannot make. */
export const validateForEnvironment = (config: VideoConfig, env: EnvironmentInfo): FieldError[] => {
  const errors: FieldError[] = [];
  const { output, captions, audio } = config;

  if (
    output.hardwareAcceleration === 'required' &&
    !supportsHardwareAcceleration(output.codec, env.platform)
  ) {
    errors.push({
      path: 'output.hardwareAcceleration',
      message: `${output.codec} has no hardware encoder on ${env.platform}.`,
    });
  }
  if (output.concurrency !== null) {
    const resolved = resolveConcurrency(output.concurrency, env.cpuCount);
    if (resolved > env.cpuCount) {
      errors.push({
        path: 'output.concurrency',
        message: `This machine has ${env.cpuCount} cores; concurrency ${resolved} is too high.`,
      });
    } else if (resolved < 1) {
      errors.push({
        path: 'output.concurrency',
        message: `${output.concurrency} of ${env.cpuCount} cores is less than one.`,
      });
    }
  }
  if (env.fontFamilies && !env.fontFamilies.has(captions.fontFamily)) {
    errors.push({
      path: 'captions.fontFamily',
      message: `"${captions.fontFamily}" is not a Google Font.`,
    });
  }
  if (
    env.musicTracks &&
    audio.music.source === 'library' &&
    audio.music.trackId !== null &&
    !env.musicTracks.has(audio.music.trackId)
  ) {
    errors.push({
      path: 'audio.music.trackId',
      message: `Unknown library track "${audio.music.trackId}".`,
    });
  }
  if (
    env.uploads &&
    audio.music.source === 'upload' &&
    audio.music.uploadId !== null &&
    !env.uploads.has(audio.music.uploadId)
  ) {
    errors.push({
      path: 'audio.music.uploadId',
      message: 'The uploaded music file no longer exists.',
    });
  }
  return errors;
};
