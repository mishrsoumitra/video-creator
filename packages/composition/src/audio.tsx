import type { CompositionProps } from '@vc/config';
import React, { useMemo } from 'react';
import { Html5Audio, useVideoConfig } from 'remotion';
import { duckedMusicVolume, speakingIntervals } from './layout';

/**
 * Audio for the browser preview. Final renders are muted and the audio is mixed by ffmpeg
 * (sidechain ducking + loudnorm); here ducking is approximated from the word timings.
 */
export const PreviewAudio: React.FC<CompositionProps> = ({ config, plan }) => {
  const { fps } = useVideoConfig();
  const intervals = useMemo(() => speakingIntervals(plan.words), [plan.words]);
  const { audio } = config;
  const rate = audio.unlockPlaybackRate ? audio.narrationPlaybackRate : 1;
  return (
    <>
      <Html5Audio
        src={plan.audio.narrationSrc}
        volume={Math.min(1, audio.narrationVolume)}
        playbackRate={rate}
      />
      {plan.audio.musicSrc && audio.music.source !== 'none' ? (
        <Html5Audio
          src={plan.audio.musicSrc}
          loop
          volume={(f) =>
            duckedMusicVolume((f / fps) * 1000, intervals, audio.music.volume, audio.ducking)
          }
        />
      ) : null}
    </>
  );
};
