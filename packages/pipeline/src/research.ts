import { z } from 'zod';
import { CACHE_TTL_MS, cacheKeys } from './cache';
import { PipelineError, throwIfAborted, type StageContext } from './context';
import { tryExtractJsonObject } from './json';
import type { ChatMessage, SearchProvider, TextProvider } from './roles';
import type { FetchedPage, PageFetcher } from './services';
import { normalizeForMatch, splitSentences } from './text';

export type Source = { id: string; kind: 'web' | 'user'; title: string; url: string | null };
export type Fact = { id: string; text: string; sourceId: string; quote: string };
export type FactSheet = {
  topic: string;
  method: 'user-text' | 'search';
  facts: Fact[];
  sources: Source[];
  createdAt: string;
};
export type ResearchResult = {
  factSheet: FactSheet;
  fromCache: boolean;
  droppedFacts: Array<{ text: string; reason: string }>;
};

const MAX_SOURCES = 5;
const MAX_PAGE_CHARS = 6000;
const MAX_FACTS = 40;
const MAX_USER_FACTS = 200;

const FACT_SYSTEM = [
  'You build a fact sheet for a short narrated video.',
  'Use ONLY the numbered sources below. Never add anything from memory.',
  'Every fact cites exactly one source id and includes a short quote copied verbatim from that source that supports it.',
  'Give 8 to 25 facts, most important first, no duplicates.',
  'Reply with JSON only: {"facts":[{"text":"...","sourceId":"S1","quote":"..."}]}',
].join(' ');

const FactReply = z.object({
  facts: z.array(
    z.object({
      text: z.unknown(),
      sourceId: z.unknown().optional(),
      quote: z.unknown().optional(),
    }),
  ),
});

const fromUserText = (topic: string, sourceText: string, now: Date): FactSheet => ({
  topic,
  method: 'user-text',
  facts: splitSentences(sourceText)
    .slice(0, MAX_USER_FACTS)
    .map((text, i) => ({ id: `F${i + 1}`, text, sourceId: 'U1', quote: text })),
  sources: [{ id: 'U1', kind: 'user', title: 'Your source text', url: null }],
  createdAt: now.toISOString(),
});

const pagesPrompt = (topic: string, pages: Array<FetchedPage & { id: string }>) =>
  [
    `Topic: ${topic}`,
    '',
    'Sources:',
    ...pages.map((p) => `[${p.id}] ${p.title} (${p.url})\n${p.text.slice(0, MAX_PAGE_CHARS)}\n`),
  ].join('\n');

const validateFacts = (raw: unknown, pages: Array<FetchedPage & { id: string }>) => {
  const parsed = FactReply.safeParse(raw);
  if (!parsed.success) throw new SyntaxError('The fact sheet JSON does not have a "facts" array.');
  const byId = new Map(pages.map((p) => [p.id, normalizeForMatch(p.text)]));
  const kept: Fact[] = [];
  const dropped: Array<{ text: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const item of parsed.data.facts) {
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    const sourceId = typeof item.sourceId === 'string' ? item.sourceId.trim() : '';
    const quote = typeof item.quote === 'string' ? item.quote.trim() : '';
    const drop = (reason: string) => dropped.push({ text, reason });
    if (!text || text.length > 400) drop('empty or too long');
    else if (!sourceId) drop('no source');
    else if (!byId.has(sourceId)) drop(`unknown source ${sourceId}`);
    else if (!quote) drop('no quote');
    else if (!normalizeForMatch(quote) || !byId.get(sourceId)!.includes(normalizeForMatch(quote)))
      drop('quote not found in the cited page');
    else if (seen.has(normalizeForMatch(text))) drop('duplicate');
    else {
      seen.add(normalizeForMatch(text));
      kept.push({ id: `F${kept.length + 1}`, text, sourceId, quote });
    }
    if (kept.length >= MAX_FACTS) break;
  }
  return { kept, dropped };
};

/**
 * Research. Deterministic first: pasted source text skips search and AI entirely; otherwise a
 * search provider finds pages, we fetch them ourselves, and the text model only summarises the
 * fetched pages into one-source-per-fact entries whose quotes are checked against the page text.
 */
export const runResearch = async (
  ctx: StageContext,
  input: {
    topic: string;
    lengthSeconds: number;
    sourceText?: string | undefined;
    search: SearchProvider | null;
    text: TextProvider;
    fetcher: PageFetcher;
  },
): Promise<ResearchResult> => {
  const { topic, lengthSeconds, sourceText, search, text, fetcher } = input;
  if (sourceText && sourceText.trim()) {
    ctx.log({ stage: 'research', message: 'Using your source text; research skipped.' });
    return {
      factSheet: fromUserText(topic, sourceText, ctx.now()),
      fromCache: false,
      droppedFacts: [],
    };
  }

  const key = cacheKeys.research(topic, lengthSeconds);
  const cached = await ctx.cache.get<FactSheet>(key);
  if (cached) {
    ctx.log({ stage: 'research', message: 'Reusing a fact sheet from the last week.' });
    return { factSheet: cached.value, fromCache: true, droppedFacts: [] };
  }

  if (!search) {
    throw new PipelineError(
      'research',
      'Web search is off. Paste your own source text for this video, or turn on a search provider in Settings.',
    );
  }

  throwIfAborted(ctx.signal);
  const found = await ctx.ledger.call(
    {
      stage: 'research',
      role: 'search',
      providerId: search.providerId,
      model: search.model ?? 'search-api',
      ai: search.usesModel,
      required: true,
      estimate: {
        searches: 1,
        ...(search.usesModel ? { inputTokens: 2000, outputTokens: 600 } : {}),
      },
      reason: search.usesModel
        ? 'No plain search API is configured, so a model with a search tool finds the sources.'
        : 'Plain search API for source pages (not AI).',
    },
    () => search.search({ query: topic, maxResults: MAX_SOURCES + 3 }, { signal: ctx.signal }),
  );
  const results = found.status === 'ok' ? found.value : [];

  const pages: Array<FetchedPage & { id: string }> = [];
  for (const result of results) {
    if (pages.length >= MAX_SOURCES) break;
    if (pages.some((p) => p.url === result.url)) continue;
    throwIfAborted(ctx.signal);
    try {
      const page = await fetcher.fetchPage(result.url, { signal: ctx.signal });
      if (page.text.trim().length >= 80)
        pages.push({ ...page, title: page.title || result.title, id: `S${pages.length + 1}` });
    } catch (error) {
      ctx.log({
        stage: 'research',
        message: `Could not fetch ${result.url}`,
        data: { error: String(error) },
      });
    }
  }
  if (pages.length === 0)
    throw new PipelineError(
      'research',
      'Could not fetch any source pages for this topic. Try again, or paste your own source text.',
    );

  const messages: ChatMessage[] = [{ role: 'user', content: pagesPrompt(topic, pages) }];
  const estimate = {
    inputTokens: Math.ceil(messages[0]!.content.length / 4) + 300,
    outputTokens: 1500,
  };
  const ask = async (reason: string) => {
    const outcome = await ctx.ledger.call(
      {
        stage: 'research',
        role: 'text',
        providerId: text.providerId,
        model: text.model,
        required: true,
        estimate,
        reason,
      },
      () =>
        text.complete(
          { system: FACT_SYSTEM, messages, maxOutputTokens: 3000, temperature: 0.1, json: true },
          { signal: ctx.signal },
        ),
    );
    return outcome.status === 'ok' ? outcome.value : '';
  };

  let reply = await ask(
    'Turning fetched pages into a fact sheet needs a language model (summarisation only).',
  );
  let parsed = tryExtractJsonObject(reply);
  if (!parsed.ok) {
    messages.push(
      { role: 'assistant', content: reply },
      {
        role: 'user',
        content: `That was not valid JSON (${parsed.error}). Reply with the JSON object only.`,
      },
    );
    reply = await ask('The fact sheet reply was not valid JSON; asking once more.');
    parsed = tryExtractJsonObject(reply);
    if (!parsed.ok)
      throw new PipelineError(
        'research',
        'The text model did not return a valid JSON fact sheet after one retry.',
      );
  }

  let facts: ReturnType<typeof validateFacts>;
  try {
    facts = validateFacts(parsed.value, pages);
  } catch (error) {
    throw new PipelineError('research', 'The fact sheet JSON had the wrong shape.', {
      cause: error,
    });
  }
  if (facts.kept.length === 0)
    throw new PipelineError(
      'research',
      'Research produced no verifiable facts: every fact failed the source check.',
    );

  const cited = new Set(facts.kept.map((f) => f.sourceId));
  const factSheet: FactSheet = {
    topic,
    method: 'search',
    facts: facts.kept,
    sources: pages
      .filter((p) => cited.has(p.id))
      .map((p) => ({ id: p.id, kind: 'web', title: p.title, url: p.url })),
    createdAt: ctx.now().toISOString(),
  };
  await ctx.cache.set(key, factSheet, CACHE_TTL_MS.research);
  if (facts.dropped.length > 0)
    ctx.log({ stage: 'research', message: `Dropped ${facts.dropped.length} unverifiable facts.` });
  return { factSheet, fromCache: false, droppedFacts: facts.dropped };
};
