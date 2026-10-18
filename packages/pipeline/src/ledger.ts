import type { ProviderCallResult, Role, UnitPrices, Usage } from './roles';

export const STAGES = [
  'research',
  'script',
  'voice',
  'timing',
  'scenes',
  'images',
  'captions',
  'render',
  'stitch',
  'credits',
  'checks',
] as const;
export type Stage = (typeof STAGES)[number];

export type AiCallStatus = 'ok' | 'error' | 'skipped-cap' | 'skipped-limit';

export type AiCallRecord = {
  id: string;
  jobId: string;
  stage: Stage;
  role: Role;
  providerId: string;
  model: string;
  /** Why the deterministic path was not enough. Shown on the job page. */
  reason: string;
  /** False for paid but non-AI provider calls, such as a plain search API. */
  ai: boolean;
  required: boolean;
  status: AiCallStatus;
  units: Usage;
  costUsd: number;
  priced: boolean;
  startedAt: string;
  durationMs: number;
  error?: string;
};

export type PriceLookup = (providerId: string, model: string, role: Role) => UnitPrices | null;

export const priceUsage = (usage: Usage, prices: UnitPrices | null): number => {
  if (!prices) return 0;
  return (
    ((usage.inputTokens ?? 0) * (prices.inputPerMTok ?? 0)) / 1e6 +
    ((usage.outputTokens ?? 0) * (prices.outputPerMTok ?? 0)) / 1e6 +
    (usage.searches ?? 0) * (prices.perSearch ?? 0) +
    ((usage.characters ?? 0) * (prices.perMChars ?? 0)) / 1e6 +
    ((usage.audioSeconds ?? 0) / 60) * (prices.perAudioMinute ?? 0) +
    (usage.images ?? 0) * (prices.perImage ?? 0)
  );
};

export class CostCapError extends Error {
  readonly capUsd: number;
  readonly spentUsd: number;
  readonly projectedUsd: number;
  readonly stage: Stage;
  constructor(init: { capUsd: number; spentUsd: number; projectedUsd: number; stage: Stage }) {
    super(
      `The per-job cost cap of $${init.capUsd.toFixed(2)} would be exceeded at the ${init.stage} stage ` +
        `($${init.spentUsd.toFixed(4)} spent, $${init.projectedUsd.toFixed(4)} projected).`,
    );
    this.name = 'CostCapError';
    this.capUsd = init.capUsd;
    this.spentUsd = init.spentUsd;
    this.projectedUsd = init.projectedUsd;
    this.stage = init.stage;
  }
}

export class CallLimitError extends Error {
  constructor(limit: number, stage: Stage) {
    super(`This job reached its limit of ${limit} provider calls at the ${stage} stage.`);
    this.name = 'CallLimitError';
  }
}

export type CallMeta = {
  stage: Stage;
  role: Role;
  providerId: string;
  model: string;
  reason: string;
  /** Required calls fail the job at the cap; optional ones are skipped and logged. */
  required: boolean;
  /** Expected usage, priced before the call to enforce the cap. */
  estimate: Usage;
  /** Defaults to true. */
  ai?: boolean;
};

export type CallOutcome<T> =
  { status: 'ok'; value: T; record: AiCallRecord } | { status: 'skipped'; record: AiCallRecord };

export type LedgerOptions = {
  jobId: string;
  capUsd: number;
  /** Spent by earlier runs of the same job (a retry or a rerender): the cap is per job. */
  initialSpentUsd?: number;
  maxCalls?: number;
  prices: PriceLookup;
  now?: () => Date;
  onRecord?: (record: AiCallRecord) => void;
};

/**
 * Every provider call goes through here: it records which stage asked, why, what it used and what
 * it cost, and enforces the per-job cost cap and a hard call limit (runaway-loop protection).
 */
export class AiLedger {
  readonly records: AiCallRecord[] = [];
  private readonly options: Required<Omit<LedgerOptions, 'onRecord' | 'initialSpentUsd'>> &
    Pick<LedgerOptions, 'onRecord' | 'initialSpentUsd'>;
  private counter = 0;

  constructor(options: LedgerOptions) {
    this.options = {
      ...options,
      maxCalls: options.maxCalls ?? 200,
      now: options.now ?? (() => new Date()),
    };
  }

  get spentUsd(): number {
    return (
      (this.options.initialSpentUsd ?? 0) + this.records.reduce((sum, r) => sum + r.costUsd, 0)
    );
  }

  get jobId(): string {
    return this.options.jobId;
  }

  aiRecords(): AiCallRecord[] {
    return this.records.filter((r) => r.ai);
  }

  private attempted(): number {
    return this.records.filter((r) => r.status === 'ok' || r.status === 'error').length;
  }

  private push(
    meta: CallMeta,
    patch: Pick<AiCallRecord, 'status' | 'units' | 'costUsd' | 'model' | 'durationMs'> & {
      error?: string;
      startedAt: Date;
      priced: boolean;
    },
  ): AiCallRecord {
    const record: AiCallRecord = {
      id: `${this.options.jobId}-${++this.counter}`,
      jobId: this.options.jobId,
      stage: meta.stage,
      role: meta.role,
      providerId: meta.providerId,
      model: patch.model,
      reason: meta.reason,
      ai: meta.ai ?? true,
      required: meta.required,
      status: patch.status,
      units: patch.units,
      costUsd: patch.costUsd,
      priced: patch.priced,
      startedAt: patch.startedAt.toISOString(),
      durationMs: patch.durationMs,
      ...(patch.error === undefined ? {} : { error: patch.error }),
    };
    this.records.push(record);
    this.options.onRecord?.(record);
    return record;
  }

  async call<T>(meta: CallMeta, fn: () => Promise<ProviderCallResult<T>>): Promise<CallOutcome<T>> {
    if (!meta.reason.trim()) throw new Error('Every provider call needs a reason.');
    const prices = this.options.prices(meta.providerId, meta.model, meta.role);
    const startedAt = this.options.now();
    const base = {
      units: meta.estimate,
      costUsd: 0,
      model: meta.model,
      durationMs: 0,
      startedAt,
      priced: prices !== null,
    };

    if (this.attempted() >= this.options.maxCalls) {
      const record = this.push(meta, { ...base, status: 'skipped-limit' });
      if (meta.required) throw new CallLimitError(this.options.maxCalls, meta.stage);
      return { status: 'skipped', record };
    }

    const projected = this.spentUsd + priceUsage(meta.estimate, prices);
    if (projected > this.options.capUsd + 1e-12) {
      const record = this.push(meta, { ...base, status: 'skipped-cap' });
      if (meta.required) {
        throw new CostCapError({
          capUsd: this.options.capUsd,
          spentUsd: this.spentUsd,
          projectedUsd: projected,
          stage: meta.stage,
        });
      }
      return { status: 'skipped', record };
    }

    const t0 = Date.now();
    try {
      const result = await fn();
      const record = this.push(meta, {
        status: 'ok',
        units: result.usage,
        costUsd: priceUsage(result.usage, prices),
        model: result.model || meta.model,
        durationMs: Date.now() - t0,
        startedAt,
        priced: prices !== null,
      });
      return { status: 'ok', value: result.value, record };
    } catch (error) {
      this.push(meta, {
        ...base,
        status: 'error',
        units: {},
        durationMs: Date.now() - t0,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
