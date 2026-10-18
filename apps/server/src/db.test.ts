import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUILT_IN_PRESETS, SCHEMA_DEFAULTS, createPresetRecord } from '@vc/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, openDb, type Db } from './db';

let dir: string;
let db: Db;
let clock = 1_000_000;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vc-db-'));
  db = openDb(join(dir, 'app.sqlite'), { now: () => clock });
});
afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('database', () => {
  it('migrates to the current schema version and reopens cleanly', () => {
    expect(db.schemaVersion()).toBe(SCHEMA_VERSION);
    db.close();
    db = openDb(join(dir, 'app.sqlite'), { now: () => clock });
    expect(db.schemaVersion()).toBe(SCHEMA_VERSION);
  });

  it('stores settings with defaults and partial updates', () => {
    expect(db.settings.get()).toMatchObject({
      costCapUsd: 2,
      visionRankAlways: false,
      visionFinalCheck: false,
      defaultPresetId: 'documentary',
    });
    db.settings.put({ costCapUsd: 0.5 });
    expect(db.settings.get()).toMatchObject({ costCapUsd: 0.5, visionFinalCheck: false });
  });

  it('keeps one slot per role, starting untested', () => {
    expect(db.roles.get('text')).toMatchObject({
      role: 'text',
      mode: 'provider',
      providerId: null,
      test: { status: 'untested' },
    });
    db.roles.put({ ...db.roles.get('text'), providerId: 'openai', model: 'gpt-x' });
    expect(db.roles.get('text')).toMatchObject({ providerId: 'openai', model: 'gpt-x' });
    expect(db.roles.all().map((r) => r.role)).toEqual([
      'text',
      'search',
      'voice',
      'align',
      'vision',
    ]);
  });

  it('stores only masked credentials, never the key', () => {
    db.credentials.put({ id: 'openai', label: 'OpenAI API key', masked: '••••abcd' });
    expect(db.credentials.all()).toEqual([
      { id: 'openai', label: 'OpenAI API key', masked: '••••abcd', updatedAt: expect.any(String) },
    ]);
    db.credentials.delete('openai');
    expect(db.credentials.all()).toEqual([]);
  });

  it('stores user presets with case-insensitive unique names', () => {
    const p = createPresetRecord({ name: 'My Look', config: SCHEMA_DEFAULTS }, []);
    db.presets.insert(p);
    expect(db.presets.all()).toEqual([
      expect.objectContaining({ id: 'my-look', name: 'My Look', builtIn: false }),
    ]);
    expect(() => db.presets.insert({ ...p, id: 'other', name: 'my look' })).toThrow();
    db.presets.update('my-look', { description: 'warm' });
    expect(db.presets.get('my-look')?.description).toBe('warm');
    db.presets.delete('my-look');
    expect(db.presets.get('my-look')).toBeUndefined();
    expect(BUILT_IN_PRESETS.length).toBeGreaterThan(0);
  });

  it('round-trips a job and its stages and AI calls', () => {
    db.jobs.insert({
      id: 'j1',
      topic: 'Apollo',
      lengthSeconds: 60,
      config: SCHEMA_DEFAULTS,
      request: { sourceText: 'x' },
    });
    db.stages.upsert('j1', 'research', { status: 'running' });
    db.stages.upsert('j1', 'research', { status: 'done', detail: 'ok' });
    db.aiCalls.insert({
      id: 'c1',
      jobId: 'j1',
      stage: 'script',
      role: 'text',
      providerId: 'openai',
      model: 'm',
      reason: 'r',
      ai: true,
      required: true,
      status: 'ok',
      units: {},
      costUsd: 0.01,
      priced: true,
      startedAt: 'now',
      durationMs: 5,
    });
    db.jobs.update('j1', { status: 'review', plan: null });
    const job = db.jobs.get('j1')!;
    expect(job).toMatchObject({ id: 'j1', topic: 'Apollo', status: 'review', renders: 0 });
    expect(job.config).toEqual(SCHEMA_DEFAULTS);
    expect(db.stages.list('j1')).toEqual([
      expect.objectContaining({ stage: 'research', status: 'done', detail: 'ok' }),
    ]);
    expect(db.aiCalls.list('j1').map((c) => c.id)).toEqual(['c1']);
    expect(db.aiCalls.spent('j1')).toBeCloseTo(0.01, 10);
    db.jobs.delete('j1');
    expect(db.jobs.get('j1')).toBeUndefined();
    expect(db.aiCalls.list('j1')).toEqual([]);
  });

  it('is a cache store with expiry', async () => {
    await db.cache.set('k', { a: 1 }, 100);
    expect(await db.cache.get('k')).toEqual({ value: { a: 1 }, createdAt: 1_000_000 });
    clock += 100;
    expect(await db.cache.get('k')).toBeNull();
  });

  it('records render samples and timed transitions', () => {
    db.samples.insert({
      features: {
        frames: 10,
        fps: 30,
        megapixels: 2,
        concurrency: 4,
        vector: {} as never,
        transitions: ['film-burn'],
      },
      elapsedMs: 1000,
      source: 'benchmark',
    });
    expect(db.samples.all()).toHaveLength(1);
    db.timedTransitions.add(['film-burn', 'fade']);
    expect([...db.timedTransitions.get()].sort()).toEqual(['fade', 'film-burn']);
  });
});
