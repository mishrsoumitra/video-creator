import { describe, expect, it } from 'vitest';
import { AiLedger, CallLimitError, CostCapError, priceUsage, type PriceLookup } from './ledger';
import type { ProviderCallResult, Usage } from './roles';

const prices: PriceLookup = (providerId) =>
  providerId === 'openai'
    ? {
        inputPerMTok: 2,
        outputPerMTok: 8,
        perSearch: 0.01,
        perMChars: 15,
        perAudioMinute: 0.006,
        perImage: 0.001,
      }
    : providerId === 'local'
      ? {}
      : null;

const ok =
  <T>(
    value: T,
    usage: Usage = { inputTokens: 1000, outputTokens: 500 },
  ): (() => Promise<ProviderCallResult<T>>) =>
  async () => ({
    value,
    usage,
    model: 'gpt-test',
  });

const ledger = (capUsd = 1, maxCalls = 200) =>
  new AiLedger({
    jobId: 'job1',
    capUsd,
    maxCalls,
    prices,
    now: () => new Date('2026-10-18T12:00:00Z'),
  });

const meta = (patch: Partial<Parameters<AiLedger['call']>[0]> = {}) => ({
  stage: 'script' as const,
  role: 'text' as const,
  providerId: 'openai',
  model: 'gpt-test',
  reason: 'Writing narration to a word budget needs a language model.',
  required: true,
  estimate: { inputTokens: 1000, outputTokens: 500 },
  ...patch,
});

describe('priceUsage', () => {
  it('prices every kind of unit', () => {
    const p = prices('openai', 'm', 'text')!;
    expect(priceUsage({ inputTokens: 1_000_000 }, p)).toBeCloseTo(2, 10);
    expect(priceUsage({ outputTokens: 500_000 }, p)).toBeCloseTo(4, 10);
    expect(priceUsage({ searches: 3 }, p)).toBeCloseTo(0.03, 10);
    expect(priceUsage({ characters: 10_000 }, p)).toBeCloseTo(0.15, 10);
    expect(priceUsage({ audioSeconds: 90 }, p)).toBeCloseTo(0.009, 10);
    expect(priceUsage({ images: 6 }, p)).toBeCloseTo(0.006, 10);
  });

  it('treats unpriced units as free and unknown prices as zero', () => {
    expect(priceUsage({ inputTokens: 5000 }, {})).toBe(0);
    expect(priceUsage({ inputTokens: 5000 }, null)).toBe(0);
  });
});

describe('AiLedger: every AI call is logged with its stage and reason', () => {
  it('records a successful call with usage, cost, model and reason', async () => {
    const l = ledger();
    const result = await l.call(meta(), ok('hello'));
    expect(result).toMatchObject({ status: 'ok', value: 'hello' });
    expect(l.records).toHaveLength(1);
    expect(l.records[0]).toMatchObject({
      jobId: 'job1',
      stage: 'script',
      role: 'text',
      providerId: 'openai',
      model: 'gpt-test',
      reason: 'Writing narration to a word budget needs a language model.',
      status: 'ok',
      ai: true,
      units: { inputTokens: 1000, outputTokens: 500 },
      priced: true,
    });
    expect(l.records[0]!.costUsd).toBeCloseTo(0.006, 10);
    expect(l.spentUsd).toBeCloseTo(0.006, 10);
  });

  it('refuses a call without a reason', async () => {
    await expect(ledger().call(meta({ reason: '  ' }), ok('x'))).rejects.toThrow(/reason/);
  });

  it('flags calls whose price is unknown', async () => {
    const l = ledger();
    await l.call(meta({ providerId: 'mystery' }), ok('x'));
    expect(l.records[0]).toMatchObject({ priced: false, costUsd: 0 });
  });

  it('logs non-AI provider calls too (e.g. a plain search API), marked ai: false', async () => {
    const l = ledger();
    await l.call(
      meta({
        stage: 'research',
        role: 'search',
        ai: false,
        reason: 'Plain search API for sources.',
      }),
      ok([], { searches: 1 }),
    );
    expect(l.records[0]).toMatchObject({ ai: false, role: 'search' });
    expect(l.aiRecords()).toHaveLength(0);
  });

  it('records failures and rethrows them', async () => {
    const l = ledger();
    await expect(
      l.call(meta(), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(l.records[0]).toMatchObject({ status: 'error', error: 'boom', costUsd: 0 });
  });

  it('reports the model the API actually reached', async () => {
    const l = ledger();
    await l.call(meta({ model: 'alias-latest' }), async () => ({
      value: 1,
      usage: {},
      model: 'model-2026-10-01',
    }));
    expect(l.records[0]!.model).toBe('model-2026-10-01');
  });
});

describe('per-job cost cap stops a runaway loop', () => {
  it('fails a required call that would exceed the cap, before spending', async () => {
    const l = ledger(0.01);
    await l.call(meta(), ok('a')); // 0.006
    let called = false;
    await expect(
      l.call(meta(), async () => {
        called = true;
        return { value: 'b', usage: {}, model: 'm' };
      }),
    ).rejects.toBeInstanceOf(CostCapError);
    expect(called).toBe(false);
    expect(l.records.at(-1)).toMatchObject({ status: 'skipped-cap' });
  });

  it('skips an optional call that would exceed the cap and says so', async () => {
    const l = ledger(0.001);
    const result = await l.call(
      meta({
        required: false,
        stage: 'images',
        role: 'vision',
        reason: 'Best image score below threshold.',
      }),
      ok('x'),
    );
    expect(result.status).toBe('skipped');
    expect(l.records[0]).toMatchObject({ status: 'skipped-cap', required: false });
    expect(l.spentUsd).toBe(0);
  });

  it('a loop of optional calls stops spending at the cap', async () => {
    const l = ledger(0.02);
    let done = 0;
    for (let i = 0; i < 100; i++) {
      const r = await l.call(meta({ required: false }), ok('x'));
      if (r.status === 'ok') done++;
    }
    expect(done).toBe(3);
    expect(l.spentUsd).toBeLessThanOrEqual(0.02);
  });

  it('local providers cost nothing and never hit the cap', async () => {
    const l = ledger(0);
    const r = await l.call(meta({ providerId: 'local' }), ok('x', { inputTokens: 10_000_000 }));
    expect(r.status).toBe('ok');
  });

  it('enforces a maximum number of calls per job', async () => {
    const l = ledger(100, 3);
    for (let i = 0; i < 3; i++) await l.call(meta({ required: false }), ok('x'));
    expect((await l.call(meta({ required: false }), ok('x'))).status).toBe('skipped');
    await expect(l.call(meta(), ok('x'))).rejects.toBeInstanceOf(CallLimitError);
  });

  it('counts spending from earlier runs of the same job against the cap', async () => {
    const l = new AiLedger({ jobId: 'j', capUsd: 0.01, prices, initialSpentUsd: 0.008 });
    expect(l.spentUsd).toBeCloseTo(0.008, 10);
    await expect(l.call(meta(), ok('x'))).rejects.toBeInstanceOf(CostCapError);
  });

  it('notifies listeners of every record', async () => {
    const seen: string[] = [];
    const l = new AiLedger({ jobId: 'j', capUsd: 1, prices, onRecord: (r) => seen.push(r.status) });
    await l.call(meta(), ok('x'));
    expect(seen).toEqual(['ok']);
  });
});
