import { targetSceneCount, type AnimationKind } from '@vc/config';
import { z } from 'zod';
import { PipelineError, throwIfAborted, type StageContext } from './context';
import { tryExtractJsonObject } from './json';
import type { FactSheet } from './research';
import type { ChatMessage, TextProvider } from './roles';
import { countWords, splitSentences, STOPWORDS, wordBudget } from './text';

export type ScriptScene = { narration: string; imageQuery: string; keywords: string[] };

export type Script = {
  title: string;
  scenes: ScriptScene[];
  wordCount: number;
  budget: number;
  targetScenes: number;
  truncated: boolean;
  budgetRetried: boolean;
  formatRetried: boolean;
};

export type ScriptResult = { script: Script; warnings: string[] };

const ScriptReply = z.object({
  title: z.string().max(200).optional(),
  scenes: z.array(
    z.object({
      narration: z.unknown(),
      imageQuery: z.unknown().optional(),
      keywords: z.unknown().optional(),
    }),
  ),
});

const systemPrompt = (lengthSeconds: number, budget: number, scenes: number) =>
  [
    `You write the narration for a ${lengthSeconds}-second narrated explainer video.`,
    'Write plain, spoken English: short sentences, no lists, no headings, no stage directions.',
    'Give it a story shape: a hook in the first sentence, a build through the middle, and a clear payoff at the end.',
    'Use only facts from the fact sheet. Never invent numbers, dates or names.',
    `Write exactly ${scenes} scenes. Each scene is one to three sentences of narration plus an image search query of 2 to 6 concrete, visual words (things a photograph could show).`,
    `Hard limit: at most ${budget} words of narration in total. Aim for ${Math.round(budget * 0.85)} to ${budget}.`,
    'Reply with JSON only: {"title":"...","scenes":[{"narration":"...","imageQuery":"...","keywords":["..."]}]}',
  ].join(' ');

const factsPrompt = (topic: string, sheet: FactSheet) =>
  [
    `Topic: ${topic}`,
    '',
    'Fact sheet:',
    ...sheet.facts.map((f) => `- ${f.text} [${f.sourceId}]`),
  ].join('\n');

const deriveQuery = (narration: string): string =>
  narration
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, ''))
    .filter((w) => w.length > 2 && !STOPWORDS.has(w.toLowerCase()))
    .slice(0, 5)
    .join(' ');

const toScenes = (raw: unknown): { title: string; scenes: ScriptScene[] } | null => {
  const parsed = ScriptReply.safeParse(raw);
  if (!parsed.success) return null;
  const scenes = parsed.data.scenes
    .map((s): ScriptScene | null => {
      const narration =
        typeof s.narration === 'string' ? s.narration.replace(/\s+/g, ' ').trim() : '';
      if (!narration) return null;
      const query =
        typeof s.imageQuery === 'string' && s.imageQuery.trim()
          ? s.imageQuery.trim()
          : deriveQuery(narration);
      const keywords = Array.isArray(s.keywords)
        ? s.keywords
            .filter((k): k is string => typeof k === 'string' && k.trim().length > 0)
            .map((k) => k.trim())
        : [];
      return { narration, imageQuery: query || narration.slice(0, 60), keywords };
    })
    .filter((s): s is ScriptScene => s !== null);
  if (scenes.length === 0) return null;
  return { title: parsed.data.title?.trim() || 'Untitled', scenes };
};

const totalWords = (scenes: readonly ScriptScene[]) =>
  scenes.reduce((sum, s) => sum + countWords(s.narration), 0);

/**
 * Keeps whole sentences, in order, until the next one would break the budget. If even the first
 * sentence is too long, it is cut at a word boundary and closed with a full stop.
 */
export const truncateToBudget = (scenes: readonly ScriptScene[], budget: number): ScriptScene[] => {
  if (totalWords(scenes) <= budget) return scenes.map((s) => ({ ...s }));
  const out: ScriptScene[] = [];
  let used = 0;
  outer: for (const scene of scenes) {
    const kept: string[] = [];
    for (const sentence of splitSentences(scene.narration)) {
      const words = countWords(sentence);
      if (used + words > budget) {
        if (used === 0 && kept.length === 0 && out.length === 0) {
          const cut = sentence
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, budget)
            .join(' ')
            .replace(/[,;:—–-]+$/, '');
          kept.push(/[.!?]$/.test(cut) ? cut : `${cut}.`);
        }
        if (kept.length > 0) out.push({ ...scene, narration: kept.join(' ') });
        break outer;
      }
      kept.push(sentence);
      used += words;
    }
    if (kept.length > 0) out.push({ ...scene, narration: kept.join(' ') });
  }
  return out;
};

/** Brings the scene count within ±20% of the target without touching the words. */
const fitSceneCount = (scenes: ScriptScene[], target: number): ScriptScene[] => {
  const tolerance = Math.max(1, Math.round(target * 0.2));
  let out = scenes.map((s) => ({ ...s, keywords: [...s.keywords] }));
  while (out.length > target + tolerance) {
    let best = 0;
    for (let i = 1; i < out.length - 1; i++) {
      if (
        countWords(out[i]!.narration) + countWords(out[i + 1]!.narration) <
        countWords(out[best]!.narration) + countWords(out[best + 1]!.narration)
      )
        best = i;
    }
    const [a, b] = [out[best]!, out[best + 1]!];
    out = [
      ...out.slice(0, best),
      {
        narration: `${a.narration} ${b.narration}`,
        imageQuery: a.imageQuery,
        keywords: [...new Set([...a.keywords, ...b.keywords])],
      },
      ...out.slice(best + 2),
    ];
  }
  while (out.length < target - tolerance) {
    let best = -1;
    let most = 1;
    out.forEach((s, i) => {
      const n = splitSentences(s.narration).length;
      if (n > most) {
        most = n;
        best = i;
      }
    });
    if (best === -1) break;
    const parts = splitSentences(out[best]!.narration);
    const half = Math.ceil(parts.length / 2);
    const first = { ...out[best]!, narration: parts.slice(0, half).join(' ') };
    const second = { ...out[best]!, narration: parts.slice(half).join(' ') };
    out = [...out.slice(0, best), first, second, ...out.slice(best + 1)];
  }
  return out;
};

const NUMBER = /\b\d[\d,]*(?:\.\d+)?\b/g;
const numbersIn = (text: string) => [...text.matchAll(NUMBER)].map((m) => m[0].replace(/,/g, ''));

const unsupportedNumbers = (scenes: readonly ScriptScene[], sheet: FactSheet): string[] => {
  const known = new Set(sheet.facts.flatMap((f) => [...numbersIn(f.text), ...numbersIn(f.quote)]));
  const flagged = [...new Set(scenes.flatMap((s) => numbersIn(s.narration)))].filter(
    (n) => !known.has(n),
  );
  return flagged.map((n) => `The script mentions "${n}", which is not in the fact sheet.`);
};

/**
 * Script. Always AI: writing narration to a word budget with a story shape needs a language
 * model. The budget is enforced by code: over budget → sent back once → then truncated at a
 * sentence boundary.
 */
export const runScript = async (
  ctx: StageContext,
  input: {
    topic: string;
    lengthSeconds: number;
    animationKind: AnimationKind;
    factSheet: FactSheet;
    text: TextProvider;
  },
): Promise<ScriptResult> => {
  const { topic, lengthSeconds, animationKind, factSheet, text } = input;
  const budget = wordBudget(lengthSeconds);
  const targetScenes = targetSceneCount(lengthSeconds, animationKind);
  const system = systemPrompt(lengthSeconds, budget, targetScenes);
  const messages: ChatMessage[] = [{ role: 'user', content: factsPrompt(topic, factSheet) }];

  const ask = async (reason: string): Promise<string> => {
    throwIfAborted(ctx.signal);
    const promptChars = system.length + messages.reduce((s, m) => s + m.content.length, 0);
    const outcome = await ctx.ledger.call(
      {
        stage: 'script',
        role: 'text',
        providerId: text.providerId,
        model: text.model,
        required: true,
        reason,
        estimate: {
          inputTokens: Math.ceil(promptChars / 4),
          outputTokens: Math.ceil(budget * 1.6 + targetScenes * 25),
        },
      },
      () =>
        text.complete(
          {
            system,
            messages,
            maxOutputTokens: Math.ceil(budget * 3 + 400),
            temperature: 0.7,
            json: true,
          },
          { signal: ctx.signal },
        ),
    );
    return outcome.status === 'ok' ? outcome.value : '';
  };

  let formatRetried = false;
  let budgetRetried = false;
  let reply = await ask(
    'Writing narration to a word budget with a story shape needs a language model.',
  );
  let parsed = (() => {
    const json = tryExtractJsonObject(reply);
    return json.ok ? toScenes(json.value) : null;
  })();
  if (!parsed) {
    formatRetried = true;
    messages.push(
      { role: 'assistant', content: reply },
      {
        role: 'user',
        content:
          'That was not valid JSON with at least one scene. Reply with the JSON object only, in the format given.',
      },
    );
    reply = await ask('The script reply was not valid JSON with scenes; asking once more.');
    const json = tryExtractJsonObject(reply);
    parsed = json.ok ? toScenes(json.value) : null;
    if (!parsed)
      throw new PipelineError(
        'script',
        'The text model did not return a valid JSON script with scenes after one retry.',
      );
  }

  let { title, scenes } = parsed;
  let words = totalWords(scenes);
  if (words > budget) {
    budgetRetried = true;
    messages.push(
      { role: 'assistant', content: reply },
      {
        role: 'user',
        content: `That script has ${words} words; the hard limit is ${budget}. Rewrite it to at most ${budget} words, keeping exactly ${targetScenes} scenes and the same JSON format.`,
      },
    );
    reply = await ask(
      `The script was ${words} words, over the hard budget of ${budget}; sent back once to be shortened.`,
    );
    const json = tryExtractJsonObject(reply);
    const retry = json.ok ? toScenes(json.value) : null;
    if (retry) ({ title, scenes } = retry);
    words = totalWords(scenes);
  }

  let truncated = false;
  if (words > budget) {
    scenes = truncateToBudget(scenes, budget);
    truncated = true;
    ctx.log({
      stage: 'script',
      message: `Script truncated at a sentence boundary to ${totalWords(scenes)} words (budget ${budget}).`,
    });
  }

  scenes = fitSceneCount(scenes, targetScenes);
  const script: Script = {
    title,
    scenes,
    wordCount: totalWords(scenes),
    budget,
    targetScenes,
    truncated,
    budgetRetried,
    formatRetried,
  };
  return { script, warnings: unsupportedNumbers(scenes, factSheet) };
};

/** The exact narration text voiced, scenes separated by blank lines. */
export const narrationText = (script: Pick<Script, 'scenes'>): string =>
  script.scenes.map((s) => s.narration).join('\n\n');

export const sceneWordCounts = (script: Pick<Script, 'scenes'>): number[] =>
  script.scenes.map((s) => countWords(s.narration));
