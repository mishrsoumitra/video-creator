import { afterEach, describe, expect, it } from 'vitest';
import type { FactSheet } from './research';
import { runScript, truncateToBudget } from './script';
import { FakeTextProvider, testContext } from './testing';
import { countWords, wordBudget } from './text';

const factSheet: FactSheet = {
  topic: 'Apollo',
  method: 'search',
  createdAt: '2026-10-18T00:00:00Z',
  sources: [{ id: 'S1', kind: 'web', title: 'Apollo', url: 'https://a.example' }],
  facts: [
    {
      id: 'F1',
      text: 'Apollo 11 landed on July 20, 1969.',
      sourceId: 'S1',
      quote: 'Apollo 11 landed on July 20, 1969.',
    },
    {
      id: 'F2',
      text: 'Twelve astronauts walked on the Moon.',
      sourceId: 'S1',
      quote: 'twelve astronauts',
    },
    { id: 'F3', text: 'About 650 million people watched.', sourceId: 'S1', quote: '650 million' },
  ],
};

const reply = (narrations: string[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    title: 'One giant leap',
    scenes: narrations.map((narration, i) => ({
      narration,
      imageQuery: `apollo moon photo ${i}`,
      keywords: ['apollo'],
    })),
    ...extra,
  });

/** n sentences of exactly `wordsEach` words. */
const sentences = (n: number, wordsEach = 5) =>
  Array.from({ length: n }, (_, i) =>
    `Word ${'x '.repeat(wordsEach - 2)}end${i}.`.replace(/\s+/g, ' '),
  ).join(' ');

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

const setup = async (capUsd = 5) => {
  const t = await testContext({ capUsd });
  cleanup = t.files.cleanup;
  return t;
};

const run = async (
  replies: string[],
  patch: Partial<Parameters<typeof runScript>[1]> = {},
  capUsd = 5,
) => {
  const t = await setup(capUsd);
  const text = new FakeTextProvider(replies);
  const result = await runScript(t.ctx, {
    topic: 'Apollo',
    lengthSeconds: 30,
    animationKind: 'documentary',
    factSheet,
    text,
    ...patch,
  });
  return { ...t, text, result };
};

describe('script: always AI, with a hard word budget enforced by code', () => {
  it('asks once, with the budget, scene count, story shape and facts in the prompt', async () => {
    const narrations = [
      'Apollo 11 landed on July 20, 1969.',
      'Twelve astronauts walked on the Moon.',
      'About 650 million people watched.',
      'It changed history.',
      'We still look up.',
    ];
    const { result, text, ledger } = await run([reply(narrations)]);
    expect(text.requests).toHaveLength(1);
    const req = text.requests[0]!;
    expect(req.json).toBe(true);
    expect(req.system).toContain(`at most ${wordBudget(30)} words`);
    expect(req.system).toMatch(/exactly 5 scenes/);
    expect(req.system).toMatch(/hook/i);
    expect(req.messages[0]!.content).toContain('Apollo 11 landed on July 20, 1969.');
    expect(result.script.scenes.map((s) => s.narration)).toEqual(narrations);
    expect(result.script.truncated).toBe(false);
    expect(result.script.budgetRetried).toBe(false);
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0]).toMatchObject({ stage: 'script', role: 'text', required: true });
    expect(ledger.records[0]!.reason).toMatch(/language model/);
  });

  it('sends an over-budget script back once and accepts a compliant rewrite', async () => {
    const long = Array.from({ length: 5 }, () => sentences(4, 6)); // 120 words > 75
    const ok = Array.from({ length: 5 }, () => sentences(2, 6)); // 60 words
    const { result, text, ledger } = await run([reply(long), reply(ok)]);
    expect(text.requests).toHaveLength(2);
    expect(text.requests[1]!.messages.at(-1)!.content).toMatch(/120 words.*75/);
    expect(result.script.budgetRetried).toBe(true);
    expect(result.script.truncated).toBe(false);
    expect(result.script.wordCount).toBe(60);
    expect(ledger.records[1]!.reason).toMatch(/over the hard budget/);
  });

  it('truncates at a sentence boundary when the rewrite is still over budget (no third call)', async () => {
    const long = Array.from({ length: 5 }, () => sentences(4, 6)); // 120 words
    const { result, text } = await run([reply(long), reply(long)]);
    expect(text.requests).toHaveLength(2);
    expect(result.script.truncated).toBe(true);
    expect(result.script.wordCount).toBeLessThanOrEqual(wordBudget(30));
    expect(result.script.wordCount).toBe(72); // 12 whole six-word sentences
    for (const scene of result.script.scenes) expect(scene.narration).toMatch(/[.!?]$/);
  });

  it('retries once on invalid JSON, then fails', async () => {
    const good = reply(['One.', 'Two.', 'Three.', 'Four.', 'Five.']);
    const { result, ledger } = await run(['I cannot do JSON today', good]);
    expect(result.script.scenes).toHaveLength(5);
    expect(ledger.records[1]!.reason).toMatch(/not valid JSON/);
    await expect(run(['nope', 'still nope'])).rejects.toThrow(/JSON/);
  });

  it('rejects a reply with no usable scenes', async () => {
    await expect(
      run([
        JSON.stringify({ title: 'x', scenes: [{ narration: '   ' }] }),
        JSON.stringify({ title: 'x', scenes: [] }),
      ]),
    ).rejects.toThrow(/scene/);
  });

  it('stops at the cost cap', async () => {
    await expect(run([reply(['a.'])], {}, 0)).rejects.toThrow(/cost cap/i);
  });
});

describe('script stage reads animation kind', () => {
  it('asks Dynamic for more, shorter scenes and Cinematic for fewer, longer ones', async () => {
    const asked = async (animationKind: 'dynamic' | 'cinematic') => {
      const { text } = await run(
        [
          reply([
            'a.',
            'b.',
            'c.',
            'd.',
            'e.',
            'f.',
            'g.',
            'h.',
            'i.',
            'j.',
            'k.',
            'l.',
            'm.',
            'n.',
            'o.',
            'p.',
            'q.',
          ]),
        ],
        { animationKind, lengthSeconds: 60 },
      );
      return Number(/exactly (\d+) scenes/.exec(text.requests[0]!.system!)![1]);
    };
    expect(await asked('dynamic')).toBeGreaterThan(await asked('cinematic'));
  });

  it('merges scenes when the model writes far too many', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `Scene ${i} is short.`);
    const { result } = await run([reply(many)]); // target 5
    expect(result.script.scenes.length).toBeLessThanOrEqual(6);
    expect(result.script.scenes.length).toBeGreaterThanOrEqual(4);
    expect(result.script.scenes.map((s) => s.narration).join(' ')).toBe(many.join(' '));
  });

  it('splits scenes at sentence boundaries when the model writes far too few', async () => {
    const few = ['One. Two. Three. Four.', 'Five. Six. Seven. Eight.'];
    const { result } = await run([reply(few)]); // target 5
    expect(result.script.scenes.length).toBeGreaterThanOrEqual(4);
    expect(result.script.scenes.map((s) => s.narration).join(' ')).toBe(few.join(' '));
  });
});

describe('script hygiene', () => {
  it('derives an image query when the model leaves it out', async () => {
    const raw = JSON.stringify({
      title: 't',
      scenes: [
        { narration: 'The Saturn V rocket thundered off the launch pad.' },
        { narration: 'Two.' },
        { narration: 'Three.' },
        { narration: 'Four.' },
        { narration: 'Five.' },
      ],
    });
    const { result } = await run([raw]);
    expect(result.script.scenes[0]!.imageQuery).toMatch(/saturn/i);
  });

  it('flags numbers the fact sheet does not support', async () => {
    const { result } = await run([
      reply([
        'Apollo 11 landed in 1969.',
        'Watched by 650 million.',
        'It cost 25 billion dollars.',
        'Four.',
        'Five.',
      ]),
    ]);
    expect(result.warnings).toEqual(['The script mentions "25", which is not in the fact sheet.']);
  });

  it('drops empty scenes', async () => {
    const { result } = await run([reply(['One.', '', 'Three.', 'Four.', 'Five.'])]);
    expect(result.script.scenes.map((s) => s.narration)).toEqual([
      'One.',
      'Three.',
      'Four.',
      'Five.',
    ]);
  });
});

describe('truncateToBudget', () => {
  const scene = (narration: string) => ({ narration, imageQuery: 'q', keywords: [] });

  it('keeps whole sentences in order until the budget is reached', () => {
    const out = truncateToBudget(
      [scene('One two three. Four five six.'), scene('Seven eight nine.')],
      7,
    );
    expect(out.map((s) => s.narration)).toEqual(['One two three. Four five six.']);
  });

  it('drops scenes that end up empty', () => {
    const out = truncateToBudget([scene('One two three.'), scene('Four five six seven eight.')], 4);
    expect(out.map((s) => s.narration)).toEqual(['One two three.']);
  });

  it('cuts a single over-long first sentence at a word boundary and closes it', () => {
    const out = truncateToBudget([scene('one two three four five six seven eight nine ten')], 4);
    expect(out.map((s) => s.narration)).toEqual(['one two three four.']);
    expect(countWords(out[0]!.narration)).toBe(4);
  });

  it('returns everything when already within budget', () => {
    const input = [scene('One. Two.')];
    expect(truncateToBudget(input, 10)).toEqual(input);
  });
});
