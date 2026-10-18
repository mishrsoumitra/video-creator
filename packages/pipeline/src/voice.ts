import { extname } from 'node:path';
import { alignWordsToScript, charsToWords, rescaleTimings } from './alignment';
import { CACHE_TTL_MS, cacheKeys, sha256 } from './cache';
import { PipelineError, throwIfAborted, type MediaOps, type StageContext } from './context';
import type { AlignProvider, TimedWord, VoiceProvider } from './roles';
import { sceneSpans, type SceneSpanResult } from './scenes';
import { narrationText, sceneWordCounts, type Script } from './script';
import { splitSentences } from './text';

/** Conservative per-request limit that fits every TTS provider (OpenAI's is 4,096 characters). */
export const TTS_CHUNK_CHARS = 3000;

export type VoiceResult = {
  source: 'recording' | 'tts' | 'cache';
  /** 48 kHz wav in the job folder. */
  audioPath: string;
  durationMs: number;
  /** The text that was voiced (the script text for a recording). */
  text: string;
  /** Word timings when the TTS returned them in the same call. */
  words: TimedWord[] | null;
  audioSha: string;
  provider: { providerId: string; model: string; voiceId: string } | null;
};

type TtsCacheEntry = {
  audioCachePath: string;
  durationMs: number;
  words: TimedWord[] | null;
  audioSha: string;
};

/** Whole sentences packed up to `maxChars`; a longer sentence is split at word boundaries. */
export const chunkForTts = (text: string, maxChars: number): string[] => {
  if (text.length <= maxChars) return [text];
  const pieces: string[] = [];
  for (const sentence of splitSentences(text)) {
    if (sentence.length <= maxChars) {
      pieces.push(sentence);
      continue;
    }
    let current = '';
    for (const word of sentence.split(' ')) {
      if (current && current.length + 1 + word.length > maxChars) {
        pieces.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) pieces.push(current);
  }
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + 1 + piece.length > maxChars) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
};

/**
 * Voice. Deterministic first: the user's own recording when uploaded. Otherwise TTS, which is a
 * model, but there is no non-model way to get a human-sounding voice from text. The same script
 * and voice reuse cached audio and timings.
 */
export const runVoice = async (
  ctx: StageContext,
  input: {
    script: Script;
    recordingPath?: string | undefined;
    voice: VoiceProvider | null;
    media: MediaOps;
    chunkChars?: number;
  },
): Promise<VoiceResult> => {
  const { script, recordingPath, voice, media } = input;
  const text = narrationText(script);
  const audioPath = ctx.files.pathFor('narration.wav');

  if (recordingPath) {
    const copied = await ctx.files.copyIn(
      recordingPath,
      `narration-recording${extname(recordingPath) || '.wav'}`,
    );
    await media.toWav(copied, audioPath);
    const durationMs = await media.durationMs(audioPath);
    ctx.log({ stage: 'voice', message: 'Using your recording; no TTS needed.' });
    return {
      source: 'recording',
      audioPath,
      durationMs,
      text,
      words: null,
      audioSha: sha256(await ctx.files.read(audioPath)),
      provider: null,
    };
  }

  if (!voice) {
    throw new PipelineError(
      'voice',
      'No voice provider is set up. Upload your own recording for this video, or choose a voice in Settings.',
    );
  }
  const provider = { providerId: voice.providerId, model: voice.model, voiceId: voice.voiceId };
  const key = cacheKeys.tts({ text, ...provider });
  const cached = await ctx.cache.get<TtsCacheEntry>(key);
  if (cached && (await ctx.files.exists(cached.value.audioCachePath))) {
    await ctx.files.copyIn(cached.value.audioCachePath, 'narration.wav');
    ctx.log({
      stage: 'voice',
      message: 'Reusing narration audio for this exact script and voice.',
    });
    return {
      source: 'cache',
      audioPath,
      durationMs: cached.value.durationMs,
      text,
      words: cached.value.words,
      audioSha: cached.value.audioSha,
      provider,
    };
  }

  const limit = input.chunkChars ?? TTS_CHUNK_CHARS;
  const chunks = chunkForTts(text, limit);
  const parts: string[] = [];
  let words: TimedWord[] | null = voice.returnsTimings ? [] : null;
  let offsetMs = 0;
  for (const [i, chunk] of chunks.entries()) {
    throwIfAborted(ctx.signal);
    const part =
      chunks.length > 1
        ? ` (part ${i + 1} of ${chunks.length}; requests are limited to ${limit} characters)`
        : '';
    const outcome = await ctx.ledger.call(
      {
        stage: 'voice',
        role: 'voice',
        providerId: voice.providerId,
        model: voice.model,
        required: true,
        estimate: { characters: chunk.length },
        reason: `There is no non-model way to get a human-sounding voice from text${part}.`,
      },
      () => voice.synthesize({ text: chunk }, { signal: ctx.signal }),
    );
    if (outcome.status !== 'ok') throw new PipelineError('voice', 'Speech synthesis was skipped.');
    const speech = outcome.value;
    const partPath = await ctx.files.write(
      `narration-part-${i + 1}.${speech.format}`,
      speech.audio,
    );
    parts.push(partPath);
    if (words)
      words = speech.alignment ? [...words, ...charsToWords(speech.alignment, offsetMs)] : null;
    offsetMs += await media.durationMs(partPath);
  }

  if (parts.length === 1) await media.toWav(parts[0]!, audioPath);
  else await media.concatAudio(parts, audioPath);
  const durationMs = await media.durationMs(audioPath);
  const bytes = await ctx.files.read(audioPath);
  const audioSha = sha256(bytes);
  const audioCachePath = await ctx.files.writeCache(`tts-${audioSha.slice(0, 32)}.wav`, bytes);
  await ctx.cache.set<TtsCacheEntry>(
    key,
    { audioCachePath, durationMs, words, audioSha },
    CACHE_TTL_MS.tts,
  );
  return { source: 'tts', audioPath, durationMs, text, words, audioSha, provider };
};

export type TimingResult = {
  words: TimedWord[];
  spans: SceneSpanResult[];
  durationMs: number;
  source: 'tts-alignment' | 'forced-alignment' | 'cache';
  matchRatio: number;
  warnings: string[];
};

/**
 * Word timing, then scene timing. Uses the alignment the TTS returned; forced alignment runs only
 * when the TTS gave none (or for a recording). Scene boundaries are then pure arithmetic.
 */
export const runTiming = async (
  ctx: StageContext,
  input: {
    script: Script;
    voice: VoiceResult;
    align: AlignProvider | null;
    playbackRate: number;
    media: MediaOps;
  },
): Promise<TimingResult> => {
  const { script, voice, align, playbackRate, media } = input;
  const scriptText = narrationText(script);
  const warnings: string[] = [];
  let transcript: TimedWord[];
  let source: TimingResult['source'];

  if (voice.words) {
    transcript = voice.words;
    source = 'tts-alignment';
  } else {
    if (!align) {
      throw new PipelineError(
        'timing',
        voice.source === 'recording'
          ? 'Your recording needs a word-timing provider (local whisper.cpp or whisper-1). Set one in Settings.'
          : 'This voice returns no word timings, so a word-timing provider is needed. Set one in Settings.',
      );
    }
    const key = cacheKeys.align({
      audioSha: voice.audioSha,
      text: scriptText,
      providerId: align.providerId,
      model: align.model,
    });
    const cached = await ctx.cache.get<TimedWord[]>(key);
    if (cached) {
      transcript = cached.value;
      source = 'cache';
    } else {
      throwIfAborted(ctx.signal);
      const speechPath = ctx.files.pathFor('narration-16k.wav');
      await media.toSpeechWav(voice.audioPath, speechPath);
      const outcome = await ctx.ledger.call(
        {
          stage: 'timing',
          role: 'align',
          providerId: align.providerId,
          model: align.model,
          required: true,
          estimate: { audioSeconds: voice.durationMs / 1000 },
          reason:
            voice.source === 'recording'
              ? 'Your recording has no word timings, so a speech recogniser times each word (forced alignment).'
              : 'The TTS provider returned no word timings, so forced alignment times each word.',
        },
        () =>
          align.align(
            { audioPath: speechPath, prompt: scriptText.slice(0, 800) },
            { signal: ctx.signal },
          ),
      );
      if (outcome.status !== 'ok') throw new PipelineError('timing', 'Word alignment was skipped.');
      transcript = outcome.value;
      await ctx.cache.set(key, transcript, CACHE_TTL_MS.align);
      source = 'forced-alignment';
    }
  }

  const aligned = alignWordsToScript(scriptText, transcript, voice.durationMs);
  if (voice.source === 'recording' && aligned.matchRatio < 0.6) {
    warnings.push(
      `Your recording differs from the script (${Math.round(aligned.matchRatio * 100)}% of words matched); captions follow the script text.`,
    );
  }
  const words = playbackRate === 1 ? aligned.words : rescaleTimings(aligned.words, playbackRate);
  const durationMs =
    playbackRate === 1 ? voice.durationMs : Math.round(voice.durationMs / playbackRate);
  const spans = sceneSpans({ sceneWordCounts: sceneWordCounts(script), words, durationMs });
  return { words, spans, durationMs, source, matchRatio: aligned.matchRatio, warnings };
};
