import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Script } from './script';
import {
  FakeAlignProvider,
  FakeVoiceProvider,
  encodeTestWav,
  testContext,
  wavMediaOps,
} from './testing';
import { chunkForTts, runTiming, runVoice } from './voice';

const script = (narrations: string[]): Script => ({
  title: 'Apollo',
  scenes: narrations.map((narration) => ({ narration, imageQuery: 'apollo', keywords: [] })),
  wordCount: 0,
  budget: 150,
  targetScenes: narrations.length,
  truncated: false,
  budgetRetried: false,
  formatRetried: false,
});

const apollo = script([
  'Apollo eleven landed in 1969.',
  'Neil Armstrong stepped onto the Moon.',
  'Millions watched it live.',
]);

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});
const setup = async (capUsd = 5) => {
  const t = await testContext({ capUsd });
  cleanup = t.files.cleanup;
  return { ...t, media: wavMediaOps() };
};

describe('voice: the user’s own recording if uploaded, TTS otherwise', () => {
  it('uses an uploaded recording without any TTS call', async () => {
    const { ctx, ledger, media, files } = await setup();
    const recording = join(files.dir, 'upload.wav');
    await writeFile(recording, encodeTestWav(4200));
    const voice = new FakeVoiceProvider();
    const r = await runVoice(ctx, { script: apollo, recordingPath: recording, voice, media });
    expect(r.source).toBe('recording');
    expect(r.durationMs).toBe(4200);
    expect(r.words).toBeNull();
    expect(voice.texts).toEqual([]);
    expect(ledger.records).toEqual([]);
  });

  it('synthesises the narration once and keeps the timings TTS returned', async () => {
    const { ctx, ledger, media } = await setup();
    const voice = new FakeVoiceProvider({ returnsTimings: true, msPerChar: 50 });
    const r = await runVoice(ctx, { script: apollo, voice, media });
    expect(r.source).toBe('tts');
    expect(voice.texts).toEqual([apollo.scenes.map((s) => s.narration).join('\n\n')]);
    expect(r.words!.map((w) => w.text)).toEqual(r.text.split(/\s+/));
    expect(r.durationMs).toBe([...r.text].length * 50);
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0]).toMatchObject({
      stage: 'voice',
      role: 'voice',
      required: true,
      units: { characters: r.text.length },
    });
    expect(ledger.records[0]!.reason).toMatch(/human-sounding voice/);
  });

  it('returns no timings from an engine that does not give them', async () => {
    const { ctx, media } = await setup();
    const r = await runVoice(ctx, {
      script: apollo,
      voice: new FakeVoiceProvider({ returnsTimings: false }),
      media,
    });
    expect(r.words).toBeNull();
  });

  it('reuses audio and timings for the same script and voice (no AI on a rerun)', async () => {
    const { ctx, ledger, media } = await setup();
    const voice = new FakeVoiceProvider({ returnsTimings: true });
    const first = await runVoice(ctx, { script: apollo, voice, media });
    const second = await runVoice(ctx, { script: apollo, voice, media });
    expect(second.source).toBe('cache');
    expect(second.words).toEqual(first.words);
    expect(second.durationMs).toBe(first.durationMs);
    expect(ledger.records).toHaveLength(1);
  });

  it('does not reuse audio when the script text changes', async () => {
    const { ctx, ledger, media } = await setup();
    const voice = new FakeVoiceProvider();
    await runVoice(ctx, { script: apollo, voice, media });
    await runVoice(ctx, { script: script(['Something else.']), voice, media });
    expect(ledger.records).toHaveLength(2);
  });

  it('splits long narration under the request limit and offsets the timings of each part', async () => {
    const { ctx, ledger, media } = await setup();
    const long = script(
      Array.from(
        { length: 6 },
        (_, i) => `Scene ${i} has a sentence that is long enough to matter here.`,
      ),
    );
    const voice = new FakeVoiceProvider({ returnsTimings: true, msPerChar: 10 });
    const r = await runVoice(ctx, { script: long, voice, media, chunkChars: 150 });
    expect(voice.texts.length).toBeGreaterThan(1);
    expect(voice.texts.every((t) => t.length <= 150)).toBe(true);
    expect(ledger.records.map((x) => x.reason)).toEqual(
      voice.texts.map((_, i) => expect.stringContaining(`part ${i + 1} of ${voice.texts.length}`)),
    );
    expect(media.concatCalls).toHaveLength(1);
    for (let i = 1; i < r.words!.length; i++)
      expect(r.words![i]!.startMs).toBeGreaterThanOrEqual(r.words![i - 1]!.endMs);
    expect(r.words!.length).toBe(
      long.scenes.reduce((n, s) => n + s.narration.split(' ').length, 0),
    );
    expect(r.durationMs).toBe(voice.texts.reduce((ms, t) => ms + t.length * 10, 0));
  });

  it('fails clearly with neither a voice provider nor a recording', async () => {
    const { ctx, media } = await setup();
    await expect(runVoice(ctx, { script: apollo, voice: null, media })).rejects.toThrow(
      /recording/,
    );
  });

  it('stops at the cost cap', async () => {
    const { ctx, media } = await setup(0);
    await expect(
      runVoice(ctx, { script: apollo, voice: new FakeVoiceProvider(), media }),
    ).rejects.toThrow(/cost cap/i);
  });
});

describe('chunkForTts', () => {
  it('packs whole sentences up to the limit', () => {
    expect(chunkForTts('One two. Three four. Five six.', 20)).toEqual([
      'One two. Three four.',
      'Five six.',
    ]);
  });

  it('splits a single over-long sentence at word boundaries', () => {
    const chunks = chunkForTts('alpha beta gamma delta epsilon zeta', 12);
    expect(chunks.every((c) => c.length <= 12)).toBe(true);
    expect(chunks.join(' ')).toBe('alpha beta gamma delta epsilon zeta');
  });

  it('keeps short text in one chunk', () => {
    expect(chunkForTts('Hello.', 100)).toEqual(['Hello.']);
  });
});

describe('timing: alignment from TTS when present, forced alignment only when not', () => {
  it('uses TTS timings with no alignment call and cuts scenes between sentences', async () => {
    const { ctx, ledger, media } = await setup();
    const voiced = await runVoice(ctx, {
      script: apollo,
      voice: new FakeVoiceProvider({ returnsTimings: true, msPerChar: 50 }),
      media,
    });
    const align = new FakeAlignProvider(() => []);
    const r = await runTiming(ctx, {
      script: apollo,
      voice: voiced,
      align,
      playbackRate: 1,
      media,
    });
    expect(r.source).toBe('tts-alignment');
    expect(align.calls).toEqual([]);
    expect(ledger.records.filter((x) => x.role === 'align')).toEqual([]);
    expect(r.spans).toHaveLength(3);
    expect(r.spans[0]!.startMs).toBe(0);
    expect(r.spans.at(-1)!.endMs).toBe(voiced.durationMs);
    expect(r.words.map((w) => w.text)).toEqual(
      apollo.scenes.flatMap((s) => s.narration.split(' ')),
    );
  });

  it('runs forced alignment when the TTS returned no timings, and says why', async () => {
    const { ctx, ledger, media } = await setup();
    const voiced = await runVoice(ctx, {
      script: apollo,
      voice: new FakeVoiceProvider({ returnsTimings: false, msPerChar: 50 }),
      media,
    });
    const words = apollo.scenes
      .flatMap((s) => s.narration.split(' '))
      .map((text, i) => ({
        text: text.toLowerCase().replace(/[.]/g, ''),
        startMs: i * 300,
        endMs: i * 300 + 250,
      }));
    const align = new FakeAlignProvider(() => words);
    const r = await runTiming(ctx, {
      script: apollo,
      voice: voiced,
      align,
      playbackRate: 1,
      media,
    });
    expect(r.source).toBe('forced-alignment');
    expect(r.matchRatio).toBe(1);
    const call = ledger.records.find((x) => x.role === 'align')!;
    expect(call).toMatchObject({ stage: 'timing', required: true });
    expect(call.reason).toMatch(/no word timings/);
  });

  it('aligns an uploaded recording and warns when it strays from the script', async () => {
    const { ctx, ledger, media, files } = await setup();
    const recording = join(files.dir, 'take.wav');
    await writeFile(recording, encodeTestWav(5000));
    const voiced = await runVoice(ctx, {
      script: apollo,
      recordingPath: recording,
      voice: null,
      media,
    });
    const align = new FakeAlignProvider(() => [
      { text: 'something', startMs: 0, endMs: 400 },
      { text: 'completely', startMs: 500, endMs: 900 },
      { text: 'different', startMs: 1000, endMs: 1400 },
    ]);
    const r = await runTiming(ctx, {
      script: apollo,
      voice: voiced,
      align,
      playbackRate: 1,
      media,
    });
    expect(ledger.records.find((x) => x.role === 'align')!.reason).toMatch(/recording/);
    expect(r.warnings.join(' ')).toMatch(/differs from the script/);
    expect(r.spans.at(-1)!.endMs).toBe(5000);
  });

  it('caches alignments by audio and text', async () => {
    const { ctx, ledger, media } = await setup();
    const voiced = await runVoice(ctx, {
      script: apollo,
      voice: new FakeVoiceProvider({ returnsTimings: false }),
      media,
    });
    const align = new FakeAlignProvider(() => [{ text: 'apollo', startMs: 0, endMs: 300 }]);
    await runTiming(ctx, { script: apollo, voice: voiced, align, playbackRate: 1, media });
    const second = await runTiming(ctx, {
      script: apollo,
      voice: voiced,
      align,
      playbackRate: 1,
      media,
    });
    expect(second.source).toBe('cache');
    expect(align.calls).toHaveLength(1);
    expect(ledger.records.filter((x) => x.role === 'align')).toHaveLength(1);
  });

  it('fails clearly when timings are needed and no alignment provider is set', async () => {
    const { ctx, media } = await setup();
    const voiced = await runVoice(ctx, {
      script: apollo,
      voice: new FakeVoiceProvider({ returnsTimings: false }),
      media,
    });
    await expect(
      runTiming(ctx, { script: apollo, voice: voiced, align: null, playbackRate: 1, media }),
    ).rejects.toThrow(/word-timing/);
  });

  it('rescales every timing when the narration rate is unlocked and changed', async () => {
    const { ctx, media } = await setup();
    const voiced = await runVoice(ctx, {
      script: apollo,
      voice: new FakeVoiceProvider({ returnsTimings: true, msPerChar: 50 }),
      media,
    });
    const normal = await runTiming(ctx, {
      script: apollo,
      voice: voiced,
      align: null,
      playbackRate: 1,
      media,
    });
    const fast = await runTiming(ctx, {
      script: apollo,
      voice: voiced,
      align: null,
      playbackRate: 1.25,
      media,
    });
    expect(fast.durationMs).toBe(Math.round(normal.durationMs / 1.25));
    expect(fast.words[3]!.startMs).toBe(Math.round(normal.words[3]!.startMs / 1.25));
    expect(fast.spans.at(-1)!.endMs).toBe(fast.durationMs);
  });
});
