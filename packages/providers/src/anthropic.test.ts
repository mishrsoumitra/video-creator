import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { anthropicProvider, supportsSampling, webSearchToolType } from './anthropic';
import { createRoleProvider } from './registry';
import { createFakeFetch, jsonResponse, type FakeHandler } from './testing/fake-fetch';

const KEY = 'sk-ant-api03-test-0123456789';
const make = <R extends 'text' | 'search' | 'vision'>(
  role: R,
  handler: FakeHandler | FakeHandler[],
  extra: { model?: string; options?: Record<string, unknown> } = {},
) => {
  const fake = createFakeFetch(handler);
  return {
    fake,
    provider: createRoleProvider({
      providerId: 'anthropic',
      role,
      apiKey: KEY,
      dataDir: tmpdir(),
      fetch: fake.fetch,
      ...extra,
    }),
  };
};

const message = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 50,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  },
  ...extra,
});

describe('anthropic text (Messages API, raw HTTP)', () => {
  it('sends the required headers, system and messages, and reads text and usage', async () => {
    const { fake, provider } = make('text', () =>
      jsonResponse(message([{ type: 'text', text: 'Hi there.' }])),
    );
    const result = await provider.complete({
      system: 'Be kind.',
      messages: [{ role: 'user', content: 'Hello' }],
      maxOutputTokens: 500,
    });
    expect(result).toEqual({
      value: 'Hi there.',
      usage: { inputTokens: 50, outputTokens: 20 },
      model: 'claude-opus-5-5',
    });
    const req = fake.requests[0]!;
    expect(req.url.href).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers.get('x-api-key')).toBe(KEY);
    expect(req.headers.get('anthropic-version')).toBe('2023-06-01');
    const body = req.json as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      system: 'Be kind.',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(body.max_tokens as number).toBeGreaterThanOrEqual(16_000);
  });

  it('never sends temperature to models that reject sampling parameters', async () => {
    const { fake, provider } = make('text', () =>
      jsonResponse(message([{ type: 'text', text: 'x' }])),
    );
    await provider.complete({
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 100,
      temperature: 0.3,
    });
    expect(fake.requests[0]!.json).not.toHaveProperty('temperature');
  });

  it('sends temperature to 4.6-era models that accept it', async () => {
    const { fake, provider } = make(
      'text',
      () => jsonResponse(message([{ type: 'text', text: 'x' }])),
      { model: 'claude-sonnet-4-6' },
    );
    await provider.complete({
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 100,
      temperature: 0.3,
    });
    expect(fake.requests[0]!.json).toMatchObject({ temperature: 0.3 });
  });

  it('enables server-side refusal fallbacks on models that support them', async () => {
    const { fake, provider } = make('text', () =>
      jsonResponse(message([{ type: 'text', text: 'x' }])),
    );
    await provider.complete({ messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 100 });
    expect(fake.requests[0]!.headers.get('anthropic-beta')).toBe('server-side-fallback-2026-07-01');
    expect(fake.requests[0]!.json).toMatchObject({ fallbacks: 'default' });
    const older = make('text', () => jsonResponse(message([{ type: 'text', text: 'x' }])), {
      model: 'claude-haiku-5-5',
    });
    await older.provider.complete({
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 100,
    });
    expect(older.fake.requests[0]!.headers.get('anthropic-beta')).toBeNull();
    expect(older.fake.requests[0]!.json).not.toHaveProperty('fallbacks');
  });

  it('reports the model that actually served the request (after a fallback)', async () => {
    const { provider } = make('text', () =>
      jsonResponse(message([{ type: 'text', text: 'ok' }], { model: 'claude-opus-4-8' })),
    );
    expect(
      (await provider.complete({ messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10 }))
        .model,
    ).toBe('claude-opus-4-8');
  });

  it('sets the effort explicitly', async () => {
    const { fake, provider } = make(
      'text',
      () => jsonResponse(message([{ type: 'text', text: 'x' }])),
      { options: { effort: 'low' } },
    );
    await provider.complete({ messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10 });
    expect(fake.requests[0]!.json).toMatchObject({ output_config: { effort: 'low' } });
  });

  it('asks for JSON in the system prompt and extracts the object from fenced output', async () => {
    const { fake, provider } = make('text', () =>
      jsonResponse(message([{ type: 'text', text: 'Sure!\n```json\n{"facts":[]}\n```' }])),
    );
    const result = await provider.complete({
      system: 'Make facts.',
      messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 10,
      json: true,
    });
    expect(result.value).toBe('{"facts":[]}');
    expect((fake.requests[0]!.json as { system: string }).system).toMatch(/JSON/);
  });

  it('counts cache reads and writes as input tokens', async () => {
    const { provider } = make('text', () =>
      jsonResponse(
        message([{ type: 'text', text: 'x' }], {
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 1000,
          },
        }),
      ),
    );
    expect(
      (await provider.complete({ messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10 }))
        .usage,
    ).toEqual({ inputTokens: 1110, outputTokens: 5 });
  });

  it('turns a refusal into a non-retryable error that names the category', async () => {
    const { provider } = make('text', () =>
      jsonResponse(
        message([], {
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'cyber', explanation: 'x' },
        }),
      ),
    );
    await expect(
      provider.complete({ messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10 }),
    ).rejects.toMatchObject({
      code: 'invalid_response',
      retryable: false,
      message: expect.stringMatching(/cyber/),
    });
  });

  it('ignores thinking blocks', async () => {
    const { provider } = make('text', () =>
      jsonResponse(
        message([
          { type: 'thinking', thinking: '' },
          { type: 'text', text: 'answer' },
        ]),
      ),
    );
    expect(
      (await provider.complete({ messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 10 }))
        .value,
    ).toBe('answer');
  });
});

describe('anthropic search (web_search server tool)', () => {
  const body = message(
    [
      {
        type: 'server_tool_use',
        id: 'srvtoolu_1',
        name: 'web_search',
        input: { query: 'apollo program' },
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_1',
        content: [
          {
            type: 'web_search_result',
            url: 'https://nasa.gov/apollo',
            title: 'Apollo - NASA',
            encrypted_content: 'xx',
            page_age: 'April 30, 2025',
          },
          {
            type: 'web_search_result',
            url: 'https://en.wikipedia.org/wiki/Apollo_program',
            title: 'Apollo program',
            encrypted_content: 'yy',
          },
        ],
      },
      {
        type: 'text',
        text: 'Apollo landed twelve astronauts.',
        citations: [
          {
            type: 'web_search_result_location',
            url: 'https://en.wikipedia.org/wiki/Apollo_program',
            title: 'Apollo program',
            cited_text: 'Twelve astronauts walked on the Moon.',
            encrypted_index: 'zz',
          },
        ],
      },
    ],
    {
      usage: {
        input_tokens: 3000,
        output_tokens: 200,
        server_tool_use: { web_search_requests: 1 },
      },
    },
  );

  it('declares the web_search tool and returns results with cited text as snippets', async () => {
    const { fake, provider } = make('search', () => jsonResponse(body));
    const result = await provider.search({ query: 'Apollo program', maxResults: 5 });
    const tools = (fake.requests[0]!.json as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }]);
    expect(result.value).toEqual([
      {
        url: 'https://en.wikipedia.org/wiki/Apollo_program',
        title: 'Apollo program',
        snippet: 'Twelve astronauts walked on the Moon.',
      },
      { url: 'https://nasa.gov/apollo', title: 'Apollo - NASA' },
    ]);
    expect(result.usage).toEqual({ inputTokens: 3000, outputTokens: 200, searches: 1 });
  });

  it('uses the basic tool version on models without dynamic filtering', () => {
    expect(webSearchToolType('claude-opus-5-5')).toBe('web_search_20260209');
    expect(webSearchToolType('claude-sonnet-4-6')).toBe('web_search_20260209');
    expect(webSearchToolType('claude-haiku-4-5')).toBe('web_search_20250305');
    expect(webSearchToolType('claude-haiku-5-5')).toBe('web_search_20250305');
  });

  it('surfaces a search error result (HTTP 200) as an error when nothing was found', async () => {
    const failed = message([
      {
        type: 'web_search_tool_result',
        tool_use_id: 'x',
        content: { type: 'web_search_tool_result_error', error_code: 'too_many_requests' },
      },
    ]);
    const { provider } = make('search', () => jsonResponse(failed));
    await expect(provider.search({ query: 'x', maxResults: 3 })).rejects.toMatchObject({
      code: 'rate_limit',
    });
  });
});

describe('anthropic vision', () => {
  it('puts base64 image blocks before the text block', async () => {
    const { fake, provider } = make('vision', () =>
      jsonResponse(message([{ type: 'text', text: '1' }])),
    );
    const result = await provider.describe({
      prompt: 'Which fits?',
      images: [{ data: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' }],
      maxOutputTokens: 20,
    });
    const content = (fake.requests[0]!.json as { messages: Array<{ content: unknown[] }> })
      .messages[0]!.content;
    expect(content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AQID' } },
      { type: 'text', text: 'Which fits?' },
    ]);
    expect(result.usage.images).toBe(1);
  });
});

describe('anthropic model rules and pricing', () => {
  it('knows which models accept sampling parameters', () => {
    expect(supportsSampling('claude-opus-5-5')).toBe(false);
    expect(supportsSampling('claude-opus-4-8')).toBe(false);
    expect(supportsSampling('claude-sonnet-5')).toBe(false);
    expect(supportsSampling('claude-sonnet-4-6')).toBe(true);
    expect(supportsSampling('claude-haiku-4-5')).toBe(true);
    expect(supportsSampling('claude-opus-4-20250514')).toBe(true);
    expect(supportsSampling('claude-3-5-haiku-latest')).toBe(true);
  });

  it('prices tokens and searches', () => {
    expect(anthropicProvider.roles.text!.pricing('claude-opus-5-5')).toMatchObject({
      inputPerMTok: 4,
      outputPerMTok: 20,
    });
    expect(anthropicProvider.roles.text!.pricing('claude-sonnet-5-5')).toMatchObject({
      inputPerMTok: 2,
      outputPerMTok: 10,
    });
    expect(anthropicProvider.roles.search!.pricing('claude-opus-5-5')).toMatchObject({
      perSearch: 0.01,
    });
    expect(anthropicProvider.roles.text!.pricing('claude-unknown-9')).toBeNull();
  });
});
