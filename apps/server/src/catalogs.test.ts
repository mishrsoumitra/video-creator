import { describe, expect, it } from 'vitest';
import { defaultRegistry, googleFonts } from './catalogs';

describe('Google Fonts catalog', () => {
  const fonts = googleFonts();

  it('lists every family Remotion can load', async () => {
    const families = await fonts.families();
    expect(families.length).toBeGreaterThan(1000);
    expect(families).toEqual(expect.arrayContaining(['Inter', 'Roboto', 'Montserrat']));
  });

  it('returns FontInfo for a known family and null for an unknown one', async () => {
    expect(await fonts.info('Roboto')).toMatchObject({
      fontFamily: 'Roboto',
      importName: 'Roboto',
    });
    expect(await fonts.info('Definitely Not A Font')).toBeNull();
  });
});

describe('provider registry', () => {
  const registry = defaultRegistry();

  it('lists every provider and looks one up by id', () => {
    const ids = registry.list().map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'openai',
        'anthropic',
        'google',
        'elevenlabs',
        'openai-compatible',
        'kokoro',
        'whisper-cpp',
      ]),
    );
    expect(registry.get('anthropic')?.id).toBe('anthropic');
    expect(registry.get('nope')).toBeUndefined();
  });

  it('returns a copy, so callers cannot change the registry', () => {
    registry.list().length = 0;
    expect(registry.list().length).toBeGreaterThan(0);
  });

  it('creates a role adapter for a provider', () => {
    const text = registry.create({
      providerId: 'openai-compatible',
      role: 'text',
      apiKey: null,
      dataDir: '/tmp/vc-models',
    });
    expect(typeof text.complete).toBe('function');
  });
});
