import { z } from 'zod';
import { httpJson, invalidResponse, type HttpOptions } from './http';
import type { AdapterContext, ProviderDefinition } from './types';
import { FREE_LOCAL, extractJsonText, toBase64 } from './util';

/**
 * Any server speaking the OpenAI Chat Completions dialect: Ollama (default), LM Studio, vLLM.
 * The key is optional and goes only to the configured host; plain http is allowed for loopback.
 */

const ID = 'openai-compatible';
const DEFAULT_BASE_URL = 'http://localhost:11434/v1';

const baseUrl = z
  .string()
  .url()
  .refine(
    (value) => ['http:', 'https:'].includes(new URL(value).protocol),
    'The base URL must start with http:// or https://.',
  )
  .transform((value) => value.replace(/\/+$/, ''))
  .default(DEFAULT_BASE_URL);

const options = z.strictObject({
  baseUrl,
  /** LM Studio rejects json_object; switch to "none" there (output is still parsed for JSON). */
  jsonMode: z.enum(['json_object', 'none']).default('json_object'),
});

type ChatBody = {
  model?: string;
  choices?: Array<{
    message?: { content?: string | Array<{ type?: string; text?: string }> | null };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

const contentText = (body: ChatBody): string => {
  const content = body.choices?.[0]?.message?.content;
  const text =
    typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('');
  if (!text.trim())
    throw invalidResponse(
      ID,
      `The local model returned no text (${body.choices?.[0]?.finish_reason ?? 'no choices'}).`,
    );
  return text;
};

const chat = (ctx: AdapterContext, body: Record<string, unknown>, signal?: AbortSignal) => {
  const opts = options.parse(ctx.options);
  const http: HttpOptions = {
    providerId: ID,
    label: 'The local model server',
    fetch: ctx.fetch,
    apiKey: ctx.apiKey,
    timeoutMs: 600_000,
    maxRetries: 1,
    ...(signal ? { signal } : {}),
  };
  return httpJson<ChatBody>(
    `${opts.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(ctx.apiKey ? { authorization: `Bearer ${ctx.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: ctx.model, ...body }),
    },
    http,
  );
};

const usageOf = (body: ChatBody) => ({
  inputTokens: body.usage?.prompt_tokens ?? 0,
  outputTokens: body.usage?.completion_tokens ?? 0,
});

export const openaiCompatibleProvider: ProviderDefinition = {
  id: ID,
  label: 'Local model (Ollama, LM Studio)',
  kind: 'local',
  description: 'Any OpenAI-compatible server on your machine; no key and no cost.',
  credential: {
    id: ID,
    label: 'API key (optional)',
    helpUrl: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
    optional: true,
  },
  allowedHosts: (opts) => {
    try {
      return [new URL(String(opts.baseUrl ?? DEFAULT_BASE_URL)).hostname.replace(/^\[|\]$/g, '')];
    } catch {
      return [];
    }
  },
  roles: {
    text: {
      role: 'text',
      label: 'Chat Completions (local)',
      defaultModel: 'qwen3:8b',
      suggestedModels: ['qwen3:8b', 'llama3.2', 'gemma3:12b', 'gpt-oss:20b', 'mistral-small3.2'],
      optionsSchema: options,
      pricing: () => FREE_LOCAL,
      create: (ctx) => {
        const opts = options.parse(ctx.options);
        return {
          providerId: ID,
          model: ctx.model,
          async complete(request, callOptions) {
            const body = await chat(
              ctx,
              {
                messages: [
                  ...(request.system ? [{ role: 'system', content: request.system }] : []),
                  ...request.messages.map((m) => ({ role: m.role, content: m.content })),
                ],
                max_tokens: request.maxOutputTokens,
                ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
                ...(request.json && opts.jsonMode === 'json_object'
                  ? { response_format: { type: 'json_object' } }
                  : {}),
              },
              callOptions?.signal,
            );
            const text = contentText(body);
            return {
              value: request.json ? extractJsonText(text) : text,
              usage: usageOf(body),
              model: body.model ?? ctx.model,
            };
          },
        };
      },
    },
    vision: {
      role: 'vision',
      label: 'Chat Completions with images (local)',
      defaultModel: 'gemma3:12b',
      suggestedModels: ['gemma3:12b', 'qwen2.5vl:7b', 'llama3.2-vision'],
      optionsSchema: options,
      pricing: () => FREE_LOCAL,
      create: (ctx) => {
        const opts = options.parse(ctx.options);
        return {
          providerId: ID,
          model: ctx.model,
          async describe({ prompt, images, maxOutputTokens, json }, callOptions) {
            const body = await chat(
              ctx,
              {
                messages: [
                  {
                    role: 'user',
                    content: [
                      { type: 'text', text: prompt },
                      ...images.map((image) => ({
                        type: 'image_url',
                        image_url: { url: `data:${image.mimeType};base64,${toBase64(image.data)}` },
                      })),
                    ],
                  },
                ],
                max_tokens: maxOutputTokens,
                ...(json && opts.jsonMode === 'json_object'
                  ? { response_format: { type: 'json_object' } }
                  : {}),
              },
              callOptions?.signal,
            );
            const text = contentText(body);
            return {
              value: json ? extractJsonText(text) : text,
              usage: { ...usageOf(body), images: images.length },
              model: body.model ?? ctx.model,
            };
          },
        };
      },
    },
  },
};
