import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeKokoroProvider, type KokoroDeps } from './kokoro';
import { openaiCompatibleProvider } from './openai-compatible';
import { createRoleProvider } from './registry';
import { createFakeFetch, jsonResponse } from './testing/fake-fetch';
import { decodeWav, durationSeconds } from './wav';
import { makeWhisperCppProvider, type WhisperCppDeps } from './whisper-cpp';

const chat = (content: string) => ({
  model: 'qwen3:8b',
  choices: [{ message: { role: 'assistant', content } }],
  usage: { prompt_tokens: 12, completion_tokens: 4 },
});

describe('openai-compatible (Ollama, LM Studio)', () => {
  it('works without a key against the default local Ollama URL', async () => {
    const fake = createFakeFetch(() => jsonResponse(chat('Hello')));
    const provider = createRoleProvider({
      providerId: 'openai-compatible',
      role: 'text',
      apiKey: null,
      dataDir: tmpdir(),
      fetch: fake.fetch,
    });
    const result = await provider.complete({
      system: 'Sys',
      messages: [{ role: 'user', content: 'Hi' }],
      maxOutputTokens: 50,
    });
    expect(result).toEqual({
      value: 'Hello',
      usage: { inputTokens: 12, outputTokens: 4 },
      model: 'qwen3:8b',
    });
    const req = fake.requests[0]!;
    expect(req.url.href).toBe('http://localhost:11434/v1/chat/completions');
    expect(req.headers.get('authorization')).toBeNull();
    expect(req.json).toMatchObject({
      messages: [
        { role: 'system', content: 'Sys' },
        { role: 'user', content: 'Hi' },
      ],
      max_tokens: 50,
    });
  });

  it('sends an optional key only to the configured host, and LM Studio URLs work', async () => {
    const fake = createFakeFetch(() => jsonResponse(chat('x')));
    const provider = createRoleProvider({
      providerId: 'openai-compatible',
      role: 'text',
      apiKey: 'lm-key-0123456789',
      options: { baseUrl: 'http://127.0.0.1:1234/v1/' },
      dataDir: tmpdir(),
      fetch: fake.fetch,
    });
    await provider.complete({ messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 5 });
    expect(fake.requests[0]!.url.href).toBe('http://127.0.0.1:1234/v1/chat/completions');
    expect(fake.requests[0]!.headers.get('authorization')).toBe('Bearer lm-key-0123456789');
    expect(openaiCompatibleProvider.allowedHosts({ baseUrl: 'http://127.0.0.1:1234/v1' })).toEqual([
      '127.0.0.1',
    ]);
  });

  it('asks for a JSON object and still extracts one from chatty output', async () => {
    const fake = createFakeFetch(() =>
      jsonResponse(chat('Here you go: {"ok": true} hope that helps')),
    );
    const provider = createRoleProvider({
      providerId: 'openai-compatible',
      role: 'text',
      apiKey: null,
      dataDir: tmpdir(),
      fetch: fake.fetch,
    });
    const result = await provider.complete({
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 5,
      json: true,
    });
    expect(result.value).toBe('{"ok": true}');
    expect(fake.requests[0]!.json).toMatchObject({ response_format: { type: 'json_object' } });
  });

  it('sends images as data URLs for vision models', async () => {
    const fake = createFakeFetch(() => jsonResponse(chat('ok')));
    const provider = createRoleProvider({
      providerId: 'openai-compatible',
      role: 'vision',
      apiKey: null,
      dataDir: tmpdir(),
      fetch: fake.fetch,
    });
    await provider.describe({
      prompt: 'See',
      images: [{ data: new Uint8Array([1]), mimeType: 'image/png' }],
      maxOutputTokens: 5,
    });
    expect((fake.requests[0]!.json as { messages: unknown }).messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'See' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AQ==' } },
        ],
      },
    ]);
  });

  it('rejects a base URL that is not http(s)', () => {
    expect(() =>
      createRoleProvider({
        providerId: 'openai-compatible',
        role: 'text',
        apiKey: null,
        options: { baseUrl: 'file:///etc/passwd' },
        dataDir: tmpdir(),
        fetch: createFakeFetch([]).fetch,
      }),
    ).toThrow();
  });

  it('costs nothing', () => {
    expect(openaiCompatibleProvider.roles.text!.pricing('anything')).toEqual({
      source: expect.any(String),
    });
  });
});

describe('kokoro (local voice)', () => {
  const fakeDeps = () => {
    const generate = vi.fn(async (text: string, _options: { voice: string; speed: number }) => ({
      audio: new Float32Array(Math.round(24_000 * 0.01 * text.length)).fill(0.25),
      sampling_rate: 24_000,
    }));
    const loadModel = vi.fn(async (_args: Parameters<KokoroDeps['loadModel']>[0]) => ({
      generate,
    }));
    const deps: KokoroDeps = { loadModel };
    return { deps, generate, loadModel };
  };

  it('loads the model once into the data directory and synthesises sentence chunks into one WAV', async () => {
    const { deps, generate, loadModel } = fakeDeps();
    const definition = makeKokoroProvider(deps);
    const provider = definition.roles.voice!.create({
      apiKey: null,
      model: 'onnx-community/Kokoro-82M-v1.0-ONNX',
      options: definition.roles.voice!.optionsSchema.parse({}),
      fetch: createFakeFetch([]).fetch,
      dataDir: '/data/vc',
    });
    const text = 'First sentence is here. '.repeat(40).trim();
    const result = await provider.synthesize({ text });
    await provider.synthesize({ text: 'Again.' });
    expect(loadModel).toHaveBeenCalledTimes(1);
    expect(loadModel.mock.calls[0]![0]).toMatchObject({
      modelId: 'onnx-community/Kokoro-82M-v1.0-ONNX',
      dtype: 'q8',
      cacheDir: join('/data/vc', 'models', 'kokoro'),
    });
    expect(generate.mock.calls.length).toBeGreaterThan(1);
    expect(generate.mock.calls[0]![1]).toEqual({ voice: 'af_heart', speed: 1 });
    const wav = decodeWav(result.value.audio);
    expect(wav.sampleRate).toBe(24_000);
    expect(durationSeconds(wav)).toBeGreaterThan(0);
    expect(result.usage.characters).toBe(text.length);
    expect(provider.returnsTimings).toBe(false);
  });

  it('explains how to fix a missing kokoro-js install', async () => {
    const definition = makeKokoroProvider({
      loadModel: async () => Promise.reject(new Error("Cannot find package 'kokoro-js'")),
    });
    const provider = definition.roles.voice!.create({
      apiKey: null,
      model: 'onnx-community/Kokoro-82M-v1.0-ONNX',
      options: definition.roles.voice!.optionsSchema.parse({}),
      fetch: createFakeFetch([]).fetch,
      dataDir: '/tmp/vc-missing',
    });
    await expect(provider.synthesize({ text: 'x' })).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringMatching(/kokoro-js/),
    });
  });
});

describe('whisper.cpp (local word timing)', () => {
  const setup = (overrides: Partial<WhisperCppDeps> = {}) => {
    const calls: string[] = [];
    const deps: WhisperCppDeps = {
      hasBuildTools: async () => true,
      installWhisperCpp: vi.fn(async () => ({ alreadyExisted: false })),
      downloadWhisperModel: vi.fn(async () => ({ alreadyExisted: true })),
      transcribe: vi.fn(async () => ({ transcription: [] }) as never),
      toCaptions: vi.fn(() => ({
        captions: [
          { text: 'Hello', startMs: 0, endMs: 400, timestampMs: 200, confidence: 0.9 },
          { text: ' world', startMs: 420, endMs: 800, timestampMs: 600, confidence: 0.8 },
          { text: ' ', startMs: 800, endMs: 810, timestampMs: null, confidence: null },
        ],
      })),
      ...overrides,
    };
    const media = {
      toWav16kMono: async (input: string, output: string) => {
        calls.push(`convert ${input}`);
        await writeFile(output, new Uint8Array(4));
      },
      durationMs: async () => 2500,
    };
    const definition = makeWhisperCppProvider(deps);
    const create = (dataDir: string, model = 'base.en') =>
      definition.roles.align!.create({
        apiKey: null,
        model,
        options: definition.roles.align!.optionsSchema.parse({}),
        fetch: createFakeFetch([]).fetch,
        dataDir,
        media,
      });
    return { deps, calls, create, definition };
  };

  it('installs whisper.cpp and the model under the data directory, converts to 16 kHz, and returns words', async () => {
    const { deps, calls, create } = setup();
    const dataDir = await mkdtemp(join(tmpdir(), 'vc-whisper-'));
    const audioPath = join(dataDir, 'narration.mp3');
    await writeFile(audioPath, new Uint8Array(4));
    const result = await create(dataDir).align({ audioPath, language: 'en' });
    expect(deps.installWhisperCpp).toHaveBeenCalledWith(
      expect.objectContaining({
        to: join(dataDir, 'whisper.cpp', '1.7.6'),
        version: '1.7.6',
        printOutput: false,
      }),
    );
    expect(deps.downloadWhisperModel).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'base.en', folder: join(dataDir, 'whisper.cpp', 'models') }),
    );
    expect(calls).toEqual([`convert ${audioPath}`]);
    expect(deps.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenLevelTimestamps: true,
        splitOnWord: true,
        model: 'base.en',
        language: 'en',
        whisperCppVersion: '1.7.6',
      }),
    );
    expect(result.value).toEqual([
      { text: 'Hello', startMs: 0, endMs: 400, confidence: 0.9 },
      { text: 'world', startMs: 420, endMs: 800, confidence: 0.8 },
    ]);
    expect(result.usage).toEqual({ audioSeconds: 2.5 });
  });

  it('explains what to install when build tools are missing', async () => {
    const { create } = setup({ hasBuildTools: async () => false });
    const dataDir = await mkdtemp(join(tmpdir(), 'vc-whisper-'));
    const audioPath = join(dataDir, 'a.wav');
    await writeFile(audioPath, new Uint8Array(4));
    await expect(create(dataDir).align({ audioPath })).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringMatching(/cmake/),
    });
  });

  it('only accepts models whisper.cpp can download', () => {
    const { definition } = setup();
    expect(definition.roles.align!.validateModel!('base.en')).toBeNull();
    expect(definition.roles.align!.validateModel!('large-v3-turbo')).toBeNull();
    expect(definition.roles.align!.validateModel!('whisper-1')).toMatch(/whisper.cpp/);
  });

  it('needs the media helper to convert audio', async () => {
    const { definition } = setup();
    const provider = definition.roles.align!.create({
      apiKey: null,
      model: 'base.en',
      options: definition.roles.align!.optionsSchema.parse({}),
      fetch: createFakeFetch([]).fetch,
      dataDir: tmpdir(),
    });
    await expect(provider.align({ audioPath: '/tmp/x.wav' })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});
