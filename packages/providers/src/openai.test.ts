import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderError } from '@vc/pipeline';
import { describe, expect, it } from 'vitest';
import { openaiProvider } from './openai';
import { createRoleProvider } from './registry';
import {
  createFakeFetch,
  jsonResponse,
  pcmBytes,
  sinePcm,
  type FakeHandler,
} from './testing/fake-fetch';
import { decodeWav, durationSeconds } from './wav';

const KEY = 'sk-proj-test-0123456789';
const make = <R extends 'text' | 'search' | 'voice' | 'align' | 'vision'>(
  role: R,
  handler: FakeHandler | FakeHandler[],
  extra: {
    model?: string;
    options?: Record<string, unknown>;
    media?: Parameters<typeof createRoleProvider>[0]['media'];
  } = {},
) => {
  const fake = createFakeFetch(handler);
  const provider = createRoleProvider({
    providerId: 'openai',
    role,
    apiKey: KEY,
    dataDir: tmpdir(),
    fetch: fake.fetch,
    ...extra,
  });
  return { fake, provider };
};

const responsesBody = (text: string, extra: Record<string, unknown> = {}) => ({
  id: 'resp_1',
  model: 'gpt-6.1-sol-2026-09-30',
  status: 'completed',
  output: [
    { type: 'reasoning', id: 'rs_1', summary: [] },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    },
  ],
  usage: { input_tokens: 120, output_tokens: 45 },
  ...extra,
});

describe('openai text (Responses API)', () => {
  it('sends system as instructions, turns as input, and reads text, usage and the model reached', async () => {
    const { fake, provider } = make('text', () => jsonResponse(responsesBody('Hello!')));
    const result = await provider.complete({
      system: 'Be brief.',
      messages: [{ role: 'user', content: 'Hi' }],
      maxOutputTokens: 200,
    });
    expect(result).toEqual({
      value: 'Hello!',
      usage: { inputTokens: 120, outputTokens: 45 },
      model: 'gpt-6.1-sol-2026-09-30',
    });
    const req = fake.requests[0]!;
    expect(req.url.href).toBe('https://api.openai.com/v1/responses');
    expect(req.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    const body = req.json as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'gpt-6.1-sol',
      instructions: 'Be brief.',
      input: [{ role: 'user', content: 'Hi' }],
      store: false,
    });
  });

  it('adds output headroom for reasoning tokens and never sends temperature to reasoning models', async () => {
    const { fake, provider } = make('text', () => jsonResponse(responsesBody('x')));
    await provider.complete({
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 1000,
      temperature: 0.2,
    });
    const body = fake.requests[0]!.json as Record<string, unknown>;
    expect(body.max_output_tokens as number).toBeGreaterThan(1000);
    expect(body).not.toHaveProperty('temperature');
  });

  it('passes temperature and exact max tokens to non-reasoning models', async () => {
    const { fake, provider } = make('text', () => jsonResponse(responsesBody('x')), {
      model: 'gpt-4.1-mini',
    });
    await provider.complete({
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 300,
      temperature: 0.2,
    });
    expect(fake.requests[0]!.json).toMatchObject({ temperature: 0.2, max_output_tokens: 300 });
  });

  it('uses json_object output format and says "JSON" in the instructions when JSON is requested', async () => {
    const { fake, provider } = make('text', () => jsonResponse(responsesBody('{"a":1}')));
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'give data' }],
      maxOutputTokens: 100,
      json: true,
    });
    expect(result.value).toBe('{"a":1}');
    const body = fake.requests[0]!.json as { text: unknown; instructions: string };
    expect(body.text).toEqual({ format: { type: 'json_object' } });
    expect(body.instructions).toMatch(/JSON/);
  });

  it('sends the reasoning effort option', async () => {
    const { fake, provider } = make('text', () => jsonResponse(responsesBody('x')), {
      options: { reasoningEffort: 'low' },
    });
    await provider.complete({ messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10 });
    expect(fake.requests[0]!.json).toMatchObject({ reasoning: { effort: 'low' } });
  });

  it('treats a refusal as an error', async () => {
    const body = responsesBody('');
    (body.output[1] as { content: unknown[] }).content = [
      { type: 'refusal', refusal: 'I cannot help with that.' },
    ];
    const { provider } = make('text', () => jsonResponse(body));
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10 }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('fails clearly when the response is incomplete and empty', async () => {
    const { provider } = make('text', () =>
      jsonResponse({
        ...responsesBody(''),
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [],
      }),
    );
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10 }),
    ).rejects.toThrow(/max_output_tokens/);
  });
});

describe('openai search (web_search tool)', () => {
  const searchBody = {
    model: 'gpt-6.1-sol',
    output: [
      {
        type: 'web_search_call',
        id: 'ws_1',
        status: 'completed',
        action: {
          type: 'search',
          query: 'apollo',
          sources: [
            { type: 'url', url: 'https://nasa.gov/apollo' },
            { type: 'url', url: 'https://example.org/moon' },
          ],
        },
      },
      {
        type: 'web_search_call',
        id: 'ws_2',
        status: 'completed',
        action: { type: 'open_page', url: 'https://nasa.gov/apollo' },
      },
      {
        type: 'message',
        content: [
          {
            type: 'output_text',
            text: 'Apollo landed twelve people on the Moon. The program ended in 1972.',
            annotations: [
              {
                type: 'url_citation',
                url: 'https://www.britannica.com/topic/Apollo',
                title: 'Apollo | Britannica',
                start_index: 0,
                end_index: 39,
              },
              {
                type: 'url_citation',
                url: 'https://nasa.gov/apollo',
                title: 'Apollo - NASA',
                start_index: 40,
                end_index: 67,
              },
            ],
          },
        ],
      },
    ],
    usage: { input_tokens: 900, output_tokens: 80 },
  };

  it('asks for the web_search tool with sources included and returns cited pages first', async () => {
    const { fake, provider } = make('search', () => jsonResponse(searchBody));
    const result = await provider.search({ query: 'Apollo program', maxResults: 5 });
    const body = fake.requests[0]!.json as Record<string, unknown>;
    expect(body.tools).toEqual([{ type: 'web_search' }]);
    expect(body.include).toEqual(['web_search_call.action.sources']);
    expect(provider.usesModel).toBe(true);
    expect(result.value.map((r) => r.url)).toEqual([
      'https://www.britannica.com/topic/Apollo',
      'https://nasa.gov/apollo',
      'https://example.org/moon',
    ]);
    expect(result.value[0]).toMatchObject({
      title: 'Apollo | Britannica',
      snippet: 'Apollo landed twelve people on the Moon.',
    });
    expect(result.usage).toEqual({ inputTokens: 900, outputTokens: 80, searches: 2 });
  });

  it('caps the number of results', async () => {
    const { provider } = make('search', () => jsonResponse(searchBody));
    expect((await provider.search({ query: 'x', maxResults: 1 })).value).toHaveLength(1);
  });
});

describe('openai voice (/v1/audio/speech)', () => {
  it('requests 24 kHz PCM and wraps it in a WAV with a narrator voice', async () => {
    const pcm = sinePcm(1);
    const { fake, provider } = make(
      'voice',
      () => new Response(pcmBytes(pcm), { headers: { 'content-type': 'audio/pcm' } }),
    );
    const result = await provider.synthesize({ text: 'Hello world.' });
    const body = fake.requests[0]!.json as Record<string, unknown>;
    expect(fake.requests[0]!.url.pathname).toBe('/v1/audio/speech');
    expect(body).toMatchObject({
      model: 'gpt-4o-mini-tts',
      voice: 'marin',
      input: 'Hello world.',
      response_format: 'pcm',
    });
    expect(typeof body.instructions).toBe('string');
    expect(result.value.format).toBe('wav');
    expect(result.value.alignment).toBeNull();
    expect(provider.returnsTimings).toBe(false);
    const wav = decodeWav(result.value.audio);
    expect(wav.sampleRate).toBe(24_000);
    expect(result.usage).toEqual({ characters: 12, audioSeconds: 1 });
  });

  it('splits long scripts under the 4096-character limit and joins the audio', async () => {
    const text = 'This sentence is about forty characters. '.repeat(250).trim();
    const fake = createFakeFetch(
      () => new Response(pcmBytes(sinePcm(0.5)), { headers: { 'content-type': 'audio/pcm' } }),
    );
    const provider = createRoleProvider({
      providerId: 'openai',
      role: 'voice',
      apiKey: KEY,
      dataDir: tmpdir(),
      fetch: fake.fetch,
    });
    const result = await provider.synthesize({ text });
    expect(fake.requests.length).toBe(3);
    for (const request of fake.requests)
      expect((request.json as { input: string }).input.length).toBeLessThanOrEqual(4096);
    expect(durationSeconds(decodeWav(result.value.audio))).toBeCloseTo(1.5, 6);
    expect(result.usage.characters).toBe(text.length);
  });

  it('refuses voices that tts-1 does not have, and leaves out instructions for tts-1', async () => {
    expect(() =>
      createRoleProvider({
        providerId: 'openai',
        role: 'voice',
        model: 'tts-1',
        options: { voice: 'marin' },
        apiKey: KEY,
        dataDir: tmpdir(),
        fetch: createFakeFetch([]).fetch,
      }),
    ).toThrow(ProviderError);
    const { fake, provider } = make('voice', () => new Response(pcmBytes(sinePcm(0.1))), {
      model: 'tts-1',
      options: { voice: 'alloy' },
    });
    await provider.synthesize({ text: 'Hi.' });
    expect(fake.requests[0]!.json).not.toHaveProperty('instructions');
  });
});

describe('openai align (whisper-1 word timestamps)', () => {
  const transcript = {
    task: 'transcribe',
    language: 'english',
    duration: 2.5,
    text: 'Hello, world.',
    words: [
      { word: 'Hello', start: 0, end: 0.5 },
      { word: 'world', start: 0.6, end: 1.1 },
    ],
  };

  it('uploads the file with verbose_json and word granularity, and returns words with punctuation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vc-align-'));
    const audioPath = join(dir, 'narration.wav');
    await writeFile(audioPath, new Uint8Array([1, 2, 3, 4]));
    const { fake, provider } = make('align', () => jsonResponse(transcript));
    const result = await provider.align({ audioPath, language: 'en', prompt: 'Apollo' });
    const form = fake.requests[0]!.form!;
    expect(fake.requests[0]!.url.pathname).toBe('/v1/audio/transcriptions');
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.getAll('timestamp_granularities[]')).toEqual(['word']);
    expect(form.get('language')).toBe('en');
    expect(form.get('prompt')).toBe('Apollo');
    expect((form.get('file') as File).name).toBe('narration.wav');
    expect(result.value).toEqual([
      { text: 'Hello,', startMs: 0, endMs: 500, confidence: null },
      { text: 'world.', startMs: 600, endMs: 1100, confidence: null },
    ]);
    expect(result.usage).toEqual({ audioSeconds: 2.5 });
  });

  it('falls back to the raw words when punctuation cannot be matched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vc-align-'));
    const audioPath = join(dir, 'a.mp3');
    await writeFile(audioPath, new Uint8Array([1]));
    const { provider } = make('align', () =>
      jsonResponse({ ...transcript, text: 'something else entirely' }),
    );
    const result = await provider.align({ audioPath });
    expect(result.value.map((w) => w.text)).toEqual(['Hello', 'world']);
  });

  it('rejects models that have no word timestamps', () => {
    for (const model of [
      'gpt-4o-transcribe',
      'gpt-4o-mini-transcribe',
      'gpt-transcribe',
      'gpt-4o-transcribe-diarize',
    ]) {
      expect(() =>
        createRoleProvider({
          providerId: 'openai',
          role: 'align',
          model,
          apiKey: KEY,
          dataDir: tmpdir(),
          fetch: createFakeFetch([]).fetch,
        }),
      ).toThrow(/whisper-1/);
    }
  });

  it('shrinks files over 25 MB to 16 kHz mono WAV first, when a converter is available', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vc-align-'));
    const audioPath = join(dir, 'big.wav');
    await writeFile(audioPath, new Uint8Array(26 * 1024 * 1024));
    const converted: string[] = [];
    const media = {
      toWav16kMono: async (input: string, output: string) => {
        converted.push(input);
        await writeFile(output, new Uint8Array(10));
      },
      durationMs: async () => 1000,
    };
    const { fake, provider } = make('align', () => jsonResponse(transcript), { media });
    await provider.align({ audioPath });
    expect(converted).toEqual([audioPath]);
    expect((fake.requests[0]!.form!.get('file') as File).size).toBe(10);
  });

  it('fails clearly for a file over 25 MB with no converter', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vc-align-'));
    const audioPath = join(dir, 'big.wav');
    await writeFile(audioPath, new Uint8Array(26 * 1024 * 1024));
    const { fake, provider } = make('align', () => jsonResponse(transcript));
    await expect(provider.align({ audioPath })).rejects.toMatchObject({ code: 'bad_request' });
    expect(fake.requests).toHaveLength(0);
  });
});

describe('openai vision', () => {
  it('sends images as base64 data URLs next to the prompt', async () => {
    const { fake, provider } = make('vision', () => jsonResponse(responsesBody('[1,0]')));
    const result = await provider.describe({
      prompt: 'Rank these',
      images: [{ data: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' }],
      maxOutputTokens: 50,
    });
    const input = (
      fake.requests[0]!.json as { input: Array<{ content: Array<Record<string, string>> }> }
    ).input;
    expect(input[0]!.content[0]).toEqual({ type: 'input_text', text: 'Rank these' });
    expect(input[0]!.content[1]).toEqual({
      type: 'input_image',
      image_url: 'data:image/png;base64,iVBORw==',
    });
    expect(result.usage.images).toBe(1);
  });
});

describe('openai pricing', () => {
  it('knows the default models', () => {
    expect(openaiProvider.roles.text!.pricing('gpt-6.1-sol')).toMatchObject({
      inputPerMTok: 2,
      outputPerMTok: 10,
    });
    expect(openaiProvider.roles.search!.pricing('gpt-6.1-sol')).toMatchObject({ perSearch: 0.01 });
    expect(openaiProvider.roles.voice!.pricing('tts-1')).toMatchObject({ perMChars: 15 });
    expect(openaiProvider.roles.voice!.pricing('gpt-4o-mini-tts')).toMatchObject({
      perAudioMinute: 0.015,
    });
    expect(openaiProvider.roles.align!.pricing('whisper-1')).toMatchObject({
      perAudioMinute: 0.006,
    });
  });

  it('matches dated snapshots to their model and returns null for unknown models', () => {
    expect(openaiProvider.roles.text!.pricing('gpt-4.1-2025-04-14')).toMatchObject({
      inputPerMTok: 2,
    });
    expect(openaiProvider.roles.text!.pricing('gpt-4o-mini-2024-07-18')).toMatchObject({
      inputPerMTok: 0.15,
    });
    expect(openaiProvider.roles.text!.pricing('mystery-model')).toBeNull();
  });
});
