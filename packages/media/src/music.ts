import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaError } from './errors';
import { normalizeLoudness } from './mix';
import { probeMedia } from './probe';
import { runFfmpeg, type MediaOptions } from './process';

/** Original music generated with ffmpeg sources, so the library carries no licensing questions. */
export const LIBRARY_TRACKS = [
  { id: 'soft-pad', label: 'Soft pad', mood: 'Calm and warm: slow chords for explainers.' },
  { id: 'pulse', label: 'Pulse', mood: 'Light and upbeat: plucked arpeggios at 120 BPM.' },
  { id: 'drone', label: 'Drone', mood: 'Dark and cinematic: a low, slowly breathing drone.' },
] as const;
export type LibraryTrackId = (typeof LIBRARY_TRACKS)[number]['id'];

/** Library tracks are normalised to this integrated loudness before mixing. */
export const LIBRARY_LOUDNESS_LUFS = -20;

const f6 = (n: number) => n.toFixed(6);
/** Synthesis rate: every track is low-passed below 6 kHz, so 24 kHz halves the expression cost. */
const SYNTH_RATE = 24_000;

const softPad = (detune: number) => {
  const voice = (freq: number, rate: number, phase: number) => {
    const f = freq * detune;
    return `0.05*(sin(2*PI*${f6(f)}*t)+0.3*sin(2*PI*${f6(2 * f)}*t))*(0.8+0.2*sin(2*PI*${rate}*t+${phase}))`;
  };
  const cmaj7 = [130.81, 164.81, 196.0, 246.94]
    .map((f, i) => voice(f, 0.11 + i * 0.03, i))
    .join('+');
  const am7 = [110.0, 130.81, 164.81, 196.0]
    .map((f, i) => voice(f, 0.13 + i * 0.02, i + 1))
    .join('+');
  // The two chords cross-fade over a 16 s cycle.
  return `(0.5+0.5*sin(2*PI*t/16))*(${cmaj7})+(0.5-0.5*sin(2*PI*t/16))*(${am7})`;
};

const pulse = (pluckGain: number) => {
  const root = 'if(lt(mod(t,16),4),220,if(lt(mod(t,16),8),174.61,if(lt(mod(t,16),12),261.63,196)))';
  const step = 'mod(floor(t*4),8)';
  // root, fifth, octave arpeggio: consonant over every chord of the loop
  const semis = [0, 7, 12, 7, 0, 7, 12, 19].reduceRight(
    (acc, s, i) => (i === 7 ? String(s) : `if(eq(${step},${i}),${s},${acc})`),
    '',
  );
  const freq = `(${root})*pow(2,(${semis})/12)`;
  const m = 'mod(t,0.25)';
  const pluck = `(1-exp(-300*${m}))*exp(-18*${m})*(sin(2*PI*${freq}*t)+0.25*sin(4*PI*${freq}*t))`;
  const mb = 'mod(t,0.5)';
  const bass = `(1-exp(-200*${mb}))*exp(-9*${mb})*sin(2*PI*(${root})/4*t)`;
  return `${pluckGain}*${pluck}+0.22*${bass}`;
};

const drone = (shift: number) =>
  [
    `0.11*sin(2*PI*${f6(55 + shift)}*t)`,
    `0.09*sin(2*PI*${f6(55.15 + shift)}*t)`,
    `0.07*sin(2*PI*${f6(82.41 + shift)}*t)`,
    `0.05*sin(2*PI*${f6(110 + shift)}*t)*(0.6+0.4*sin(2*PI*t/11))`,
    `0.035*sin(2*PI*${f6(164.81 + shift)}*t)*(0.5+0.5*sin(2*PI*t/7))`,
  ].join('+');

/** lavfi sources (each for `-f lavfi -i`) and the filter_complex producing [out] for a track. */
export const trackSources = (
  id: LibraryTrackId,
  durationSeconds: number,
): { inputs: string[]; filter: string } => {
  const d = f6(durationSeconds);
  const fadeIn = Math.min(1.5, durationSeconds / 4);
  const fadeOut = Math.min(2, durationSeconds / 4);
  const fades = `afade=t=in:st=0:d=${f6(fadeIn)},afade=t=out:st=${f6(Math.max(0, durationSeconds - fadeOut))}:d=${f6(fadeOut)}`;
  switch (id) {
    case 'soft-pad':
      return {
        inputs: [`aevalsrc='${softPad(1)}|${softPad(1.003)}':s=${SYNTH_RATE}:d=${d}`],
        filter: `[0:a]lowpass=f=2200,aecho=0.8:0.6:180|360:0.25|0.15,${fades}[out]`,
      };
    case 'pulse':
      return {
        inputs: [`aevalsrc='${pulse(0.16)}|${pulse(0.13)}':s=${SYNTH_RATE}:d=${d}`],
        filter: `[0:a]lowpass=f=6000,aecho=0.8:0.5:250|375:0.25|0.2,${fades}[out]`,
      };
    case 'drone':
      return {
        inputs: [
          `aevalsrc='${drone(0)}|${drone(0.08)}':s=${SYNTH_RATE}:d=${d}`,
          `anoisesrc=color=brown:amplitude=0.05:seed=7:r=${SYNTH_RATE}:d=${d}`,
        ],
        filter: `[1:a]lowpass=f=500,aformat=channel_layouts=stereo[wind];[0:a][wind]amix=inputs=2:duration=first:normalize=0,lowpass=f=1500,aecho=0.8:0.7:400|600:0.3|0.25,${fades}[out]`,
      };
  }
};

const MAX_TRACK_MS = 2 * 60 * 60 * 1000;

/** Renders a library track of the given length to 48 kHz stereo WAV at LIBRARY_LOUDNESS_LUFS. */
export const generateLibraryTrack = async (
  trackId: LibraryTrackId,
  durationMs: number,
  outputPath: string,
  options: MediaOptions = {},
): Promise<{ outputPath: string; durationMs: number; integratedLufs: number }> => {
  if (!LIBRARY_TRACKS.some((t) => t.id === trackId))
    throw new MediaError({
      code: 'invalid_input',
      message: `Unknown library track "${String(trackId)}".`,
    });
  if (!(durationMs > 0 && durationMs <= MAX_TRACK_MS))
    throw new MediaError({
      code: 'invalid_input',
      message: 'The track length must be between 0 and 2 hours.',
    });
  const seconds = durationMs / 1000;
  const { inputs, filter } = trackSources(trackId, seconds);
  const scratch = await mkdtemp(join(tmpdir(), 'vc-music-'));
  try {
    const raw = join(scratch, 'raw.wav');
    await runFfmpeg(
      [
        '-y',
        ...inputs.flatMap((input) => ['-f', 'lavfi', '-i', input]),
        '-filter_complex',
        filter,
        '-map',
        '[out]',
        '-t',
        f6(seconds),
        '-ar',
        '48000',
        '-ac',
        '2',
        '-c:a',
        'pcm_f32le',
        raw,
      ],
      { timeoutMs: 10 * 60_000, ...options },
    );
    const normalized = await normalizeLoudness(raw, outputPath, {
      ...options,
      targetLufs: LIBRARY_LOUDNESS_LUFS,
      truePeakDb: -3,
    });
    const info = await probeMedia(outputPath, options);
    return { outputPath, durationMs: info.durationMs, integratedLufs: normalized.integratedLufs };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
};
