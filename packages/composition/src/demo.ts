import { initialConfig, type CompositionProps, type ScenePlan } from '@vc/config';

const SENTENCES = [
  'Every config field you change in Studio redraws this preview.',
  'Typographic scenes stand in when no image passes.',
  'Images push in, drift and hold, scene by scene.',
  'Captions follow the word timings of the narration.',
];

/** Word timings at a steady pace, as the timing stage would produce them. */
const demoWords = () => {
  const words: ScenePlan['words'] = [];
  let t = 200;
  SENTENCES.forEach((sentence, i) => {
    for (const w of sentence.split(' ')) {
      const len = 180 + w.length * 22;
      words.push({ text: w, startMs: t, endMs: t + len });
      t += len + 70;
    }
    t = Math.max(t, (i + 1) * 3000 + 200);
  });
  return words;
};

/** A small plan for Remotion Studio and the render smoke test; assets come from `public/demo`. */
export const demoPlan = (asset: (name: string) => string): ScenePlan => ({
  version: 1,
  title: 'Demo',
  durationMs: 12_000,
  scenes: [
    {
      id: 's1',
      startMs: 0,
      endMs: 3000,
      narration: SENTENCES[0]!,
      visual: { type: 'image', src: asset('demo/image-1.jpg'), width: 1920, height: 1080 },
      captionPlacement: 'bottom',
    },
    {
      id: 's2',
      startMs: 3000,
      endMs: 6000,
      narration: SENTENCES[1]!,
      visual: { type: 'typographic', text: 'When no image passes' },
      captionPlacement: 'bottom',
    },
    {
      id: 's3',
      startMs: 6000,
      endMs: 9000,
      narration: SENTENCES[2]!,
      visual: { type: 'image', src: asset('demo/image-2.jpg'), width: 1600, height: 1200 },
      captionPlacement: 'top',
    },
    {
      id: 's4',
      startMs: 9000,
      endMs: 12_000,
      narration: SENTENCES[3]!,
      visual: { type: 'typographic', text: 'Word by word' },
      captionPlacement: 'bottom',
    },
  ],
  words: demoWords(),
  audio: { narrationSrc: asset('demo/narration.wav'), musicSrc: null },
  palette: null,
  fonts: { caption: null },
});

export const demoProps = (asset: (name: string) => string): CompositionProps => ({
  config: initialConfig(),
  plan: demoPlan(asset),
});
