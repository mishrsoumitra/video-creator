import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_PRESETS,
  SCHEMA_DEFAULTS,
  parseExpertJson,
  resolveConfigInput,
  stringifyConfig,
} from './index';

describe('Expert: raw JSON editor validated against the schema before it is accepted', () => {
  it('accepts the JSON it produced', () => {
    const result = parseExpertJson(stringifyConfig(SCHEMA_DEFAULTS));
    expect(result).toEqual({ ok: true, config: SCHEMA_DEFAULTS });
  });

  it('pretty-prints with a stable key order', () => {
    const text = stringifyConfig(SCHEMA_DEFAULTS);
    expect(text.split('\n')[1]).toBe('  "version": 1,');
    expect(stringifyConfig(JSON.parse(text))).toBe(text);
  });

  it('reports JSON syntax errors with a line and column', () => {
    const result = parseExpertJson('{\n  "version": 1,\n  "simple": {\n}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]!.path).toBe('');
      expect(result.errors[0]!.message).toMatch(/JSON/);
      expect(result.errors[0]!.line).toBeGreaterThanOrEqual(1);
    }
  });

  it('reports schema errors by field path', () => {
    const json = JSON.parse(stringifyConfig(SCHEMA_DEFAULTS));
    json.motion.zoomAmount = 2;
    json.simple.mood = 'x';
    const result = parseExpertJson(JSON.stringify(json));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.path).sort()).toEqual(['motion.zoomAmount', 'simple']);
    }
  });

  it('fills fields the user deleted with their defaults', () => {
    const json = JSON.parse(stringifyConfig(SCHEMA_DEFAULTS));
    delete json.motion.zoomAmount;
    const result = parseExpertJson(JSON.stringify(json));
    expect(result.ok && result.config.motion.zoomAmount).toBe(SCHEMA_DEFAULTS.motion.zoomAmount);
  });

  it('rejects JSON that is not an object', () => {
    expect(parseExpertJson('[]').ok).toBe(false);
    expect(parseExpertJson('null').ok).toBe(false);
    expect(parseExpertJson('').ok).toBe(false);
  });
});

describe('resolveConfigInput (API requests may send a full config, or a preset plus overrides)', () => {
  const userPresets = [{ ...BUILT_IN_PRESETS[0]!, id: 'my-look', name: 'My look', builtIn: false }];

  it('validates a full config', () => {
    expect(resolveConfigInput({ config: SCHEMA_DEFAULTS }, userPresets)).toEqual({
      ok: true,
      config: SCHEMA_DEFAULTS,
    });
  });

  it('expands a preset id and deep-merges overrides', () => {
    const preset = BUILT_IN_PRESETS[1]!;
    const result = resolveConfigInput(
      { presetId: preset.id, overrides: { output: { fps: 60 } } },
      userPresets,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.output.fps).toBe(60);
      expect(result.config.motion).toEqual(preset.config.motion);
      expect(result.config.basedOnPreset).toBe(preset.id);
    }
  });

  it('finds user presets too', () => {
    const result = resolveConfigInput({ presetId: 'my-look' }, userPresets);
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown preset id', () => {
    const result = resolveConfigInput({ presetId: 'nope' }, userPresets);
    expect(result).toMatchObject({ ok: false, errors: [{ path: 'presetId' }] });
  });

  it('rejects overrides that break the schema, by path', () => {
    const result = resolveConfigInput(
      { presetId: BUILT_IN_PRESETS[0]!.id, overrides: { output: { crf: 99 } } },
      userPresets,
    );
    expect(result).toMatchObject({ ok: false, errors: [{ path: 'output.crf' }] });
  });

  it('rejects requests with neither or both forms', () => {
    expect(resolveConfigInput({}, userPresets).ok).toBe(false);
    expect(
      resolveConfigInput({ config: SCHEMA_DEFAULTS, presetId: 'documentary' }, userPresets).ok,
    ).toBe(false);
  });
});
