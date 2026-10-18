import { afterEach, describe, expect, it } from 'vitest';
import { runResearch } from './research';
import { FakePageFetcher, FakeSearchProvider, FakeTextProvider, testContext } from './testing';

const pages = {
  'https://a.example/apollo': {
    title: 'Apollo program',
    text: 'The Apollo program ran from 1961 to 1972. It landed twelve astronauts on the Moon between 1969 and 1972. The Saturn V rocket launched every crewed Apollo Moon mission.',
  },
  'https://b.example/moon': {
    title: 'Moon landing',
    text: 'Apollo 11 landed on July 20, 1969. Neil Armstrong was the first person to walk on the Moon. About 650 million people watched the broadcast.',
  },
};

const results = [
  { url: 'https://a.example/apollo', title: 'Apollo program' },
  { url: 'https://b.example/moon', title: 'Moon landing' },
  { url: 'https://c.example/broken', title: 'Broken page' },
];

const factSheetReply = JSON.stringify({
  facts: [
    {
      text: 'Apollo landed twelve astronauts on the Moon between 1969 and 1972.',
      sourceId: 'S1',
      quote: 'It landed twelve astronauts on the Moon between 1969 and 1972.',
    },
    {
      text: 'Neil Armstrong was the first person on the Moon.',
      sourceId: 'S2',
      quote: 'Neil Armstrong was the first person to walk on the Moon',
    },
    {
      text: 'The Saturn V launched every crewed Moon mission.',
      sourceId: 'S1',
      quote: 'the saturn v rocket launched every crewed apollo moon mission',
    },
  ],
});

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

describe('research: deterministic first', () => {
  it('uses pasted source text without any search or AI call', async () => {
    const { ctx, ledger } = await setup();
    const text = new FakeTextProvider([]);
    const search = new FakeSearchProvider(results);
    const r = await runResearch(ctx, {
      topic: 'Apollo',
      lengthSeconds: 60,
      sourceText:
        'Apollo 11 landed in 1969. Armstrong stepped out first. The crew returned safely.',
      search,
      text,
      fetcher: new FakePageFetcher({}),
    });
    expect(r.factSheet.method).toBe('user-text');
    expect(r.factSheet.facts.map((f) => f.text)).toEqual([
      'Apollo 11 landed in 1969.',
      'Armstrong stepped out first.',
      'The crew returned safely.',
    ]);
    expect(r.factSheet.sources).toEqual([
      { id: 'U1', kind: 'user', title: 'Your source text', url: null },
    ]);
    expect(r.factSheet.facts.every((f) => f.sourceId === 'U1')).toBe(true);
    expect(search.queries).toEqual([]);
    expect(text.requests).toEqual([]);
    expect(ledger.records).toEqual([]);
  });

  it('searches with a plain search API, fetches pages, and asks the text model only to summarise them', async () => {
    const { ctx, ledger } = await setup();
    const text = new FakeTextProvider([factSheetReply]);
    const search = new FakeSearchProvider(results);
    const fetcher = new FakePageFetcher(pages);
    const r = await runResearch(ctx, {
      topic: 'The Apollo program',
      lengthSeconds: 60,
      search,
      text,
      fetcher,
    });

    expect(search.queries).toEqual(['The Apollo program']);
    expect(fetcher.fetched).toContain('https://c.example/broken');
    expect(r.factSheet.method).toBe('search');
    expect(r.factSheet.facts).toHaveLength(3);
    expect(r.factSheet.sources.map((s) => s.url)).toEqual([
      'https://a.example/apollo',
      'https://b.example/moon',
    ]);
    // The prompt contains the fetched pages and forbids outside knowledge.
    const prompt = text.requests[0]!;
    expect(prompt.system).toMatch(/only/i);
    expect(prompt.messages[0]!.content).toContain('[S1] Apollo program');
    expect(prompt.json).toBe(true);

    const [searchCall, factCall] = ledger.records;
    expect(searchCall).toMatchObject({ stage: 'research', role: 'search', ai: false });
    expect(factCall).toMatchObject({ stage: 'research', role: 'text', ai: true, required: true });
    expect(factCall!.reason).toMatch(/fact sheet/i);
  });

  it('logs a model-based search as an AI call, with the reason', async () => {
    const { ctx, ledger } = await setup();
    await runResearch(ctx, {
      topic: 'Apollo',
      lengthSeconds: 60,
      search: new FakeSearchProvider(results, { usesModel: true }),
      text: new FakeTextProvider([factSheetReply]),
      fetcher: new FakePageFetcher(pages),
    });
    expect(ledger.records[0]).toMatchObject({ role: 'search', ai: true });
    expect(ledger.records[0]!.reason).toMatch(/plain search/i);
  });

  it('fails clearly when search is off and no source text was pasted', async () => {
    const { ctx } = await setup();
    await expect(
      runResearch(ctx, {
        topic: 'Apollo',
        lengthSeconds: 60,
        search: null,
        text: new FakeTextProvider([]),
        fetcher: new FakePageFetcher({}),
      }),
    ).rejects.toThrow(/paste/i);
  });

  it('fails when no page could be fetched', async () => {
    const { ctx } = await setup();
    await expect(
      runResearch(ctx, {
        topic: 'Apollo',
        lengthSeconds: 60,
        search: new FakeSearchProvider(results),
        text: new FakeTextProvider([]),
        fetcher: new FakePageFetcher({}),
      }),
    ).rejects.toThrow(/fetch/i);
  });
});

describe('research: the model never invents a fact', () => {
  const run = async (reply: string, extra: string[] = []) => {
    const { ctx, ledger } = await setup();
    const r = await runResearch(ctx, {
      topic: 'Apollo',
      lengthSeconds: 60,
      search: new FakeSearchProvider(results),
      text: new FakeTextProvider([reply, ...extra]),
      fetcher: new FakePageFetcher(pages),
    });
    return { r, ledger };
  };

  it('drops facts that cite a source that was not fetched', async () => {
    const { r } = await run(
      JSON.stringify({
        facts: [
          { text: 'Made up', sourceId: 'S9', quote: 'Apollo 11 landed on July 20, 1969.' },
          { text: 'Real', sourceId: 'S2', quote: 'Apollo 11 landed on July 20, 1969.' },
        ],
      }),
    );
    expect(r.factSheet.facts.map((f) => f.text)).toEqual(['Real']);
    expect(r.droppedFacts).toEqual([{ text: 'Made up', reason: 'unknown source S9' }]);
  });

  it('drops facts whose quote does not appear in the cited page', async () => {
    const { r } = await run(
      JSON.stringify({
        facts: [
          {
            text: 'Armstrong flew to Mars',
            sourceId: 'S2',
            quote: 'Armstrong flew to Mars in 1969',
          },
          { text: 'Real', sourceId: 'S2', quote: 'about 650 million people watched the broadcast' },
        ],
      }),
    );
    expect(r.factSheet.facts.map((f) => f.text)).toEqual(['Real']);
    expect(r.droppedFacts[0]!.reason).toMatch(/quote/);
  });

  it('drops facts with no source or no quote, and duplicates', async () => {
    const { r } = await run(
      JSON.stringify({
        facts: [
          { text: 'No source', quote: 'Apollo 11 landed on July 20, 1969.' },
          { text: 'No quote', sourceId: 'S2' },
          { text: 'Real', sourceId: 'S2', quote: 'Apollo 11 landed on July 20, 1969.' },
          { text: 'real', sourceId: 'S2', quote: 'Apollo 11 landed on July 20, 1969.' },
        ],
      }),
    );
    expect(r.factSheet.facts.map((f) => f.text)).toEqual(['Real']);
    expect(r.droppedFacts.map((d) => d.reason)).toEqual(['no source', 'no quote', 'duplicate']);
  });

  it('accepts a reply wrapped in a code fence', async () => {
    const { r } = await run('```json\n' + factSheetReply + '\n```');
    expect(r.factSheet.facts).toHaveLength(3);
  });

  it('asks once more when the reply is not JSON, then succeeds', async () => {
    const { r, ledger } = await run('Sure! Here are the facts...', [factSheetReply]);
    expect(r.factSheet.facts).toHaveLength(3);
    expect(ledger.records.filter((x) => x.role === 'text')).toHaveLength(2);
    expect(ledger.records.at(-1)!.reason).toMatch(/not valid JSON/i);
  });

  it('gives up after one retry', async () => {
    await expect(run('nope', ['still nope'])).rejects.toThrow(/JSON/);
  });

  it('fails when nothing verifiable is left', async () => {
    await expect(
      run(
        JSON.stringify({ facts: [{ text: 'x', sourceId: 'S1', quote: 'not in the page at all' }] }),
      ),
    ).rejects.toThrow(/verifiable/);
  });
});

describe('research cache: same topic and length within a week reuses the fact sheet', () => {
  it('serves the second run from cache with no provider calls', async () => {
    const { ctx, ledger } = await setup();
    const fetcher = new FakePageFetcher(pages);
    const search = new FakeSearchProvider(results);
    const text = new FakeTextProvider([factSheetReply]);
    const first = await runResearch(ctx, {
      topic: 'The Apollo Program',
      lengthSeconds: 60,
      search,
      text,
      fetcher,
    });
    const callsAfterFirst = ledger.records.length;
    const second = await runResearch(ctx, {
      topic: 'the apollo program',
      lengthSeconds: 60,
      search,
      text,
      fetcher,
    });
    expect(second.fromCache).toBe(true);
    expect(second.factSheet).toEqual(first.factSheet);
    expect(ledger.records.length).toBe(callsAfterFirst);
  });

  it('does not reuse it for a different length', async () => {
    const { ctx } = await setup();
    const fetcher = new FakePageFetcher(pages);
    const search = new FakeSearchProvider(results);
    const text = new FakeTextProvider([factSheetReply, factSheetReply]);
    await runResearch(ctx, { topic: 'Apollo', lengthSeconds: 60, search, text, fetcher });
    const second = await runResearch(ctx, {
      topic: 'Apollo',
      lengthSeconds: 90,
      search,
      text,
      fetcher,
    });
    expect(second.fromCache).toBe(false);
  });

  it('stops at the cost cap before the fact sheet call', async () => {
    const { ctx } = await setup(0);
    await expect(
      runResearch(ctx, {
        topic: 'Apollo',
        lengthSeconds: 60,
        search: new FakeSearchProvider(results),
        text: new FakeTextProvider([factSheetReply]),
        fetcher: new FakePageFetcher(pages),
      }),
    ).rejects.toThrow(/cost cap/i);
  });
});
