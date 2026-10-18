import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { googleProvider } from './google';
import { createRoleProvider } from './registry';
import { createFakeFetch, jsonResponse, type FakeHandler } from './testing/fake-fetch';

const KEY = 'AIzaSyTest0123456789abcdef';
const make = <R extends 'text' | 'search' | 'vision'>(
  role: R,
  handler: FakeHandler | FakeHandler[],
  extra: { model?: string } = {},
) => {
  const fake = createFakeFetch(handler);
  return {
    fake,
    provider: createRoleProvider({
      providerId: 'google',
      role,
      apiKey: KEY,
      dataDir: tmpdir(),
      fetch: fake.fetch,
      ...extra,
    }),
  };
};

const generate = (
  parts: unknown[],
  extra: Record<string, unknown> = {},
  candidate: Record<string, unknown> = {},
) => ({
  candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', ...candidate }],
  usageMetadata: {
    promptTokenCount: 40,
    candidatesTokenCount: 10,
    thoughtsTokenCount: 30,
    totalTokenCount: 80,
  },
  modelVersion: 'gemini-3.8-flash',
  ...extra,
});

describe('gemini text (generateContent)', () => {
  it('uses x-goog-api-key, maps roles, and counts thinking tokens as output', async () => {
    const { fake, provider } = make('text', () =>
      jsonResponse(generate([{ text: 'Hello' }, { text: ' there' }])),
    );
    const result = await provider.complete({
      system: 'Be brief.',
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hey' },
        { role: 'user', content: 'Again' },
      ],
      maxOutputTokens: 100,
    });
    expect(result).toEqual({
      value: 'Hello there',
      usage: { inputTokens: 40, outputTokens: 40 },
      model: 'gemini-3.8-flash',
    });
    const req = fake.requests[0]!;
    expect(req.url.href).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    );
    expect(req.headers.get('x-goog-api-key')).toBe(KEY);
    expect(req.url.search).toBe('');
    const body = req.json as Record<string, unknown>;
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Hi' }] },
      { role: 'model', parts: [{ text: 'Hey' }] },
      { role: 'user', parts: [{ text: 'Again' }] },
    ]);
    expect((body.generationConfig as { maxOutputTokens: number }).maxOutputTokens).toBeGreaterThan(
      100,
    );
  });

  it('skips thought parts', async () => {
    const { provider } = make('text', () =>
      jsonResponse(generate([{ text: 'thinking...', thought: true }, { text: 'answer' }])),
    );
    expect(
      (await provider.complete({ messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10 }))
        .value,
    ).toBe('answer');
  });

  it('requests application/json when JSON is wanted', async () => {
    const { fake, provider } = make('text', () => jsonResponse(generate([{ text: '{"a":1}' }])));
    await provider.complete({
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 10,
      json: true,
    });
    expect(fake.requests[0]!.json).toMatchObject({
      generationConfig: { responseMimeType: 'application/json' },
    });
  });

  it('sends temperature only to Gemini 2.x (Gemini 3+ is tuned for the default)', async () => {
    const three = make('text', () => jsonResponse(generate([{ text: 'x' }])));
    await three.provider.complete({
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 10,
      temperature: 0.2,
    });
    expect(
      (three.fake.requests[0]!.json as { generationConfig: object }).generationConfig,
    ).not.toHaveProperty('temperature');
    const two = make('text', () => jsonResponse(generate([{ text: 'x' }])), {
      model: 'gemini-2.5-flash',
    });
    await two.provider.complete({
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 10,
      temperature: 0.2,
    });
    expect(two.fake.requests[0]!.json).toMatchObject({ generationConfig: { temperature: 0.2 } });
  });

  it('turns a safety block into a non-retryable error', async () => {
    const { provider } = make('text', () =>
      jsonResponse(generate([], {}, { finishReason: 'SAFETY' })),
    );
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10 }),
    ).rejects.toMatchObject({ code: 'invalid_response', retryable: false });
    const blocked = make('text', () =>
      jsonResponse({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }),
    );
    await expect(
      blocked.provider.complete({
        messages: [{ role: 'user', content: 'x' }],
        maxOutputTokens: 10,
      }),
    ).rejects.toThrow(/PROHIBITED_CONTENT/);
  });
});

describe('gemini search (Grounding with Google Search)', () => {
  const grounded = generate(
    [{ text: 'Apollo landed twelve people. It ended in 1972.' }],
    {
      usageMetadata: {
        promptTokenCount: 20,
        candidatesTokenCount: 15,
        toolUsePromptTokenCount: 500,
      },
    },
    {
      groundingMetadata: {
        webSearchQueries: ['apollo program', 'apollo moon landings'],
        groundingChunks: [
          {
            web: {
              uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA',
              title: 'nasa.gov',
            },
          },
          {
            web: {
              uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB',
              title: 'britannica.com',
            },
          },
        ],
        groundingSupports: [
          { segment: { text: 'Apollo landed twelve people.' }, groundingChunkIndices: [1] },
        ],
      },
    },
  );

  it('enables google_search and returns the grounding chunks, supported ones first', async () => {
    const { fake, provider } = make('search', () => jsonResponse(grounded));
    const result = await provider.search({ query: 'Apollo program', maxResults: 5 });
    expect((fake.requests[0]!.json as { tools: unknown }).tools).toEqual([{ google_search: {} }]);
    expect(result.value).toEqual([
      {
        url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/BBB',
        title: 'britannica.com',
        snippet: 'Apollo landed twelve people.',
      },
      {
        url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AAA',
        title: 'nasa.gov',
      },
    ]);
    expect(result.usage).toEqual({ inputTokens: 520, outputTokens: 15, searches: 2 });
  });

  it('counts one grounded prompt for Gemini 2.5', async () => {
    const { provider } = make('search', () => jsonResponse(grounded), {
      model: 'gemini-2.5-flash',
    });
    expect((await provider.search({ query: 'x', maxResults: 5 })).usage.searches).toBe(1);
  });

  it('returns no results and no search charge when the model did not search', async () => {
    const { provider } = make('search', () => jsonResponse(generate([{ text: 'I know this.' }])));
    const result = await provider.search({ query: 'x', maxResults: 5 });
    expect(result.value).toEqual([]);
    expect(result.usage.searches).toBe(0);
  });
});

describe('gemini vision', () => {
  it('sends inline image data', async () => {
    const { fake, provider } = make('vision', () => jsonResponse(generate([{ text: 'ok' }])));
    await provider.describe({
      prompt: 'Look',
      images: [{ data: new Uint8Array([255, 216, 255]), mimeType: 'image/jpeg' }],
      maxOutputTokens: 10,
    });
    expect((fake.requests[0]!.json as { contents: unknown }).contents).toEqual([
      {
        role: 'user',
        parts: [{ text: 'Look' }, { inlineData: { mimeType: 'image/jpeg', data: '/9j/' } }],
      },
    ]);
  });
});

describe('gemini pricing follows Google’s announced dates', () => {
  it('doubles Gemini 3.8 Flash on 1 Jan 2027 and Gemini 4 Argon on 1 Dec 2026', () => {
    const text = googleProvider.roles.text!;
    expect(text.pricing('gemini-3.8-flash', new Date('2026-10-18'))).toMatchObject({
      inputPerMTok: 0.75,
      outputPerMTok: 3.75,
    });
    expect(text.pricing('gemini-3.8-flash', new Date('2027-01-01T00:00:00Z'))).toMatchObject({
      inputPerMTok: 1.5,
      outputPerMTok: 7.5,
    });
    expect(text.pricing('gemini-4-argon', new Date('2026-11-30'))).toMatchObject({
      inputPerMTok: 2,
      outputPerMTok: 10,
    });
    expect(text.pricing('gemini-4-argon', new Date('2026-12-01T00:00:00Z'))).toMatchObject({
      inputPerMTok: 4,
      outputPerMTok: 20,
    });
  });

  it('charges grounding per request at the right rate for each generation', () => {
    expect(googleProvider.roles.search!.pricing('gemini-3.8-flash')).toMatchObject({
      perSearch: 0.014,
    });
    expect(googleProvider.roles.search!.pricing('gemini-2.5-flash')).toMatchObject({
      perSearch: 0.035,
    });
  });
});
