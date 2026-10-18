import {
  BUILT_IN_PRESETS,
  SCHEMA_DEFAULTS,
  initialConfig,
  mergeConfig,
  type CatalogResponse,
  type EstimateResponse,
  type Preset,
  type ValidateConfigResponse,
} from '@vc/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestServer, type TestServer } from './test/harness';

let s: TestServer;
beforeEach(async () => {
  s = await createTestServer();
});
afterEach(async () => {
  await s.close();
});

describe('presets: built-in and "my channel look"', () => {
  it('lists the built-in presets first', async () => {
    const presets = (await s.api.get('/api/presets')).body as Preset[];
    expect(presets.slice(0, BUILT_IN_PRESETS.length).map((p) => p.id)).toEqual(
      BUILT_IN_PRESETS.map((p) => p.id),
    );
  });

  it('saves a user preset and lists it', async () => {
    const res = await s.api.post('/api/presets', {
      name: 'My channel look',
      config: initialConfig(),
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'my-channel-look', builtIn: false });
    expect(
      ((await s.api.get('/api/presets')).body as Preset[]).some((p) => p.id === 'my-channel-look'),
    ).toBe(true);
  });

  it('refuses duplicate names (case-insensitive) and built-in names', async () => {
    await s.api.post('/api/presets', { name: 'My look', config: initialConfig() });
    expect(
      (await s.api.post('/api/presets', { name: 'MY LOOK', config: initialConfig() })).status,
    ).toBe(409);
    expect(
      (await s.api.post('/api/presets', { name: 'Cinematic', config: initialConfig() })).status,
    ).toBe(409);
  });

  it('validates the config with field paths', async () => {
    const res = await s.api.post('/api/presets', {
      name: 'Broken',
      config: mergeConfig(SCHEMA_DEFAULTS, { simple: { animationSpeed: 3 } }),
    });
    expect(res.status).toBe(400);
    expect(res.raw).toContain('config.simple.animationSpeed');
  });

  it('updates and deletes user presets, but never built-ins', async () => {
    await s.api.post('/api/presets', { name: 'My look', config: initialConfig() });
    expect((await s.api.put('/api/presets/my-look', { description: 'warm' })).body).toMatchObject({
      description: 'warm',
    });
    expect((await s.api.del('/api/presets/documentary')).status).toBe(403);
    expect((await s.api.put('/api/presets/documentary', { description: 'x' })).status).toBe(403);
    expect((await s.api.del('/api/presets/my-look')).status).toBe(204);
    expect((await s.api.del('/api/presets/my-look')).status).toBe(404);
  });
});

describe('config validation, catalog and estimates', () => {
  it('validates a config: errors, warnings (never blocking) and environment checks', async () => {
    const awful = mergeConfig(initialConfig(), {
      simple: { animationSpeed: 2 },
      motion: { easing: { type: 'elastic', direction: 'out', bounciness: 1 } },
      transitions: { presentations: ['ripple'] },
      captions: { fontFamily: 'Not A Font' },
    });
    const r = (await s.api.post('/api/config/validate', { config: awful }))
      .body as ValidateConfigResponse;
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.warnings.map((w) => w.id)).toEqual(
      expect.arrayContaining(['jarring-combination', 'untimed-transition']),
    );
    expect(r.environment.map((e) => e.path)).toEqual(['captions.fontFamily']);
    const bad = (await s.api.post('/api/config/validate', { config: { simple: { mood: 1 } } }))
      .body as ValidateConfigResponse;
    expect(bad.errors[0]).toMatchObject({ path: 'simple' });
  });

  it('exposes gated transitions only once they have been timed', async () => {
    let catalog = (await s.api.get('/api/catalog')).body as CatalogResponse;
    expect(catalog.exposedTransitions).not.toContain('ripple');
    expect(catalog.exposedTransitions).toContain('dissolve');
    s.db.timedTransitions.add(['ripple']);
    catalog = (await s.api.get('/api/catalog')).body as CatalogResponse;
    expect(catalog.exposedTransitions).toContain('ripple');
    expect(catalog.timedTransitions).toEqual(['ripple']);
    expect(catalog.fonts).toContain('Inter');
    expect(catalog.musicTracks.map((t) => t.id)).toEqual(['soft-pad', 'pulse', 'drone']);
  });

  it('estimates cost from the configured providers and render time from measured renders', async () => {
    await s.completeSetup();
    let r = (await s.api.post('/api/estimate', { lengthSeconds: 60, config: initialConfig() }))
      .body as EstimateResponse;
    expect(r.cost.lines.map((l) => `${l.stage}:${l.role}`)).toEqual([
      'research:search',
      'research:text',
      'script:text',
      'voice:voice',
      'timing:align',
    ]);
    expect(r.cost.capUsd).toBe(2);
    expect(r.render.status).toBe('uncalibrated');
    const pasted = (
      await s.api.post('/api/estimate', {
        lengthSeconds: 60,
        config: initialConfig(),
        sourceTextProvided: true,
      })
    ).body as EstimateResponse;
    expect(pasted.cost.totalUsd).toBeLessThan(r.cost.totalUsd);

    // A finished render feeds the model.
    const id = (
      (
        await s.api.post('/api/jobs', {
          topic: 'Apollo program',
          lengthSeconds: 30,
          config: initialConfig(),
        })
      ).body as { id: string }
    ).id;
    await s.waitForJob(id, ['review']);
    await s.api.post(`/api/jobs/${id}/render`, { config: initialConfig() });
    await s.waitForJob(id, ['done']);
    r = (await s.api.post('/api/estimate', { lengthSeconds: 60, config: initialConfig() }))
      .body as EstimateResponse;
    expect(['ok', 'partial']).toContain(r.render.status);
    expect(r.render.seconds).toBeGreaterThan(0);
  });

  it('applies pricing overrides from Settings', async () => {
    await s.completeSetup();
    const before = (
      await s.api.post('/api/estimate', { lengthSeconds: 60, config: initialConfig() })
    ).body as EstimateResponse;
    await s.api.put('/api/settings', {
      pricingOverrides: { 'acme/acme-text-1': { inputPerMTok: 100, outputPerMTok: 100 } },
    });
    const after = (
      await s.api.post('/api/estimate', { lengthSeconds: 60, config: initialConfig() })
    ).body as EstimateResponse;
    expect(after.cost.totalUsd).toBeGreaterThan(before.cost.totalUsd);
  });

  it('serves Google Font info for the caption font picker', async () => {
    expect(((await s.api.get('/api/fonts/Roboto')).body as { fontFamily: string }).fontFamily).toBe(
      'Roboto',
    );
    expect((await s.api.get('/api/fonts/Nope')).status).toBe(404);
  });

  it('serves a library music bed at a given length, for the review preview', async () => {
    const res = await s.api.get('/api/music/soft-pad?durationMs=5000');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/audio\/wav/);
    expect((await s.api.get('/api/music/nope?durationMs=5000')).status).toBe(404);
    expect((await s.api.get('/api/music/soft-pad?durationMs=0')).status).toBe(400);
    expect((await s.api.get('/api/music/soft-pad?durationMs=abc')).status).toBe(400);
  });

  it('changes only the settings it is sent', async () => {
    await s.api.put('/api/settings', { costCapUsd: 3, visionFinalCheck: true });
    const res = await s.api.put('/api/settings', {
      pricingOverrides: { 'acme/acme-text-1': { inputPerMTok: 1 } },
    });
    expect(res.body).toMatchObject({
      costCapUsd: 3,
      visionFinalCheck: true,
      pricingOverrides: { 'acme/acme-text-1': { inputPerMTok: 1 } },
    });
    expect((await s.api.get('/api/settings')).body).toMatchObject({
      costCapUsd: 3,
      visionFinalCheck: true,
    });
    expect((await s.api.put('/api/settings', {})).body).toMatchObject({ costCapUsd: 3 });
  });

  it('round-trips settings', async () => {
    const res = await s.api.put('/api/settings', { costCapUsd: 0.75, visionRankAlways: true });
    expect(res.body).toMatchObject({
      costCapUsd: 0.75,
      visionRankAlways: true,
      visionFinalCheck: false,
    });
    expect((await s.api.put('/api/settings', { costCapUsd: -1 })).status).toBe(400);
  });
});
