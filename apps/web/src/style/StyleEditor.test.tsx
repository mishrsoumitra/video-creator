import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  BUILT_IN_PRESETS,
  FIELDS,
  applyAnimationKind,
  applyAspect,
  applyBackdropKind,
  applyCaptionStyle,
  applySpeed,
  getBuiltInPreset,
  initialConfig,
  type CatalogResponse,
  type Preset,
  type VideoConfig,
} from '@vc/config';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  allTransitionsTimed,
  catalogResponse,
  presetsResponse,
  userPreset,
} from '../test/fixtures';
import { mockApi } from '../test/mock-api';
import { StyleEditor } from './StyleEditor';
import { useStyleEditor } from './useStyleEditor';

afterEach(() => vi.unstubAllGlobals());

const Harness = ({
  catalog = catalogResponse(),
  initialPresets = presetsResponse(),
}: {
  catalog?: CatalogResponse;
  initialPresets?: Preset[];
}) => {
  const [presets, setPresets] = useState(initialPresets);
  const editor = useStyleEditor({
    initial: initialConfig(),
    presetId: 'documentary',
    presets,
    timedTransitions: catalog.timedTransitions,
  });
  return (
    <>
      <StyleEditor
        editor={editor}
        catalog={catalog}
        presets={presets}
        onPresetsChange={setPresets}
      />
      <pre data-testid="config">{JSON.stringify(editor.config)}</pre>
    </>
  );
};

const readConfig = (): VideoConfig => JSON.parse(screen.getByTestId('config').textContent!);
const timed = (c: CatalogResponse) => ({ timedTransitions: new Set(c.timedTransitions) });
const openAdvanced = () => userEvent.click(screen.getByRole('button', { name: 'Advanced' }));

describe('Simple layer: five pickers, each a bundle of settings', () => {
  it('always shows the five pickers', () => {
    render(<Harness />);
    for (const label of ['Animation', 'Backdrop', 'Animation speed', 'Captions'])
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Aspect' })).toBeInTheDocument();
  });

  it('applies the animation-kind bundle exactly', async () => {
    render(<Harness />);
    await userEvent.selectOptions(screen.getByLabelText('Animation'), 'dynamic');
    expect(readConfig()).toEqual(
      applyAnimationKind(initialConfig(), 'dynamic', timed(catalogResponse())),
    );
  });

  it('only uses film-burn in Cinematic once it has been timed on this machine', async () => {
    render(<Harness />);
    await userEvent.selectOptions(screen.getByLabelText('Animation'), 'cinematic');
    expect(readConfig().transitions.presentations).toEqual(['dissolve']);
  });

  it('uses film-burn when the server has timed it', async () => {
    render(<Harness catalog={allTransitionsTimed()} />);
    await userEvent.selectOptions(screen.getByLabelText('Animation'), 'cinematic');
    expect(readConfig().transitions.presentations).toEqual(['dissolve', 'film-burn']);
  });

  it('applies backdrop, caption style, aspect and speed through their bundle functions', async () => {
    render(<Harness />);
    let expected = initialConfig();
    await userEvent.selectOptions(screen.getByLabelText('Backdrop'), 'light');
    expected = applyBackdropKind(expected, 'light');
    await userEvent.selectOptions(screen.getByLabelText('Captions'), 'kinetic-words');
    expected = applyCaptionStyle(expected, 'kinetic-words');
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Aspect' })).getByRole('radio', { name: '9:16' }),
    );
    expected = applyAspect(expected, '9:16');
    fireEvent.change(screen.getByLabelText('Animation speed'), { target: { value: '1.5' } });
    expected = applySpeed(expected, 1.5);
    expect(readConfig()).toEqual(expected);
    expect(screen.getByText('1.5×')).toBeInTheDocument();
  });
});

describe('Style presets: named looks that set many fields at once', () => {
  it('lists built-in and user presets and marks the selected one', () => {
    render(<Harness />);
    const bar = screen.getByRole('group', { name: 'Style presets' });
    for (const p of [...BUILT_IN_PRESETS, userPreset()])
      expect(within(bar).getByRole('button', { name: p.name })).toBeInTheDocument();
    expect(within(bar).getByRole('button', { name: 'Documentary' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('sets the whole config from a preset', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Cinematic' }));
    expect(readConfig()).toEqual(getBuiltInPreset('cinematic')!.config);
    expect(screen.getByRole('button', { name: 'Cinematic' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('validates the name before saving a preset', async () => {
    const m = mockApi({
      'POST /api/presets': (ctx: { body: { name: string; config: VideoConfig } }) => ({
        id: 'warm-look',
        name: ctx.body.name,
        description: '',
        builtIn: false,
        config: ctx.body.config,
      }),
    });
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'Save as preset' }));
    const name = screen.getByLabelText('Preset name');
    await userEvent.type(name, 'Documentary');
    await userEvent.click(screen.getByRole('button', { name: 'Save preset' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/built-in/i);
    await userEvent.clear(name);
    await userEvent.type(name, 'my channel look');
    await userEvent.click(screen.getByRole('button', { name: 'Save preset' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/already exists/i);
    expect(m.calls).toHaveLength(0);
    await userEvent.clear(name);
    await userEvent.type(name, 'Warm Look');
    await userEvent.click(screen.getByRole('button', { name: 'Save preset' }));
    await waitFor(() => expect(m.callsTo('POST', '/api/presets')).toHaveLength(1));
    expect(m.calls[0]!.body).toMatchObject({ name: 'Warm Look', config: initialConfig() });
    expect(await screen.findByRole('button', { name: 'Warm Look' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

describe('Advanced layer', () => {
  it('is collapsed by default', () => {
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Advanced' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.queryByRole('slider', { name: 'Zoom amount' })).not.toBeInTheDocument();
  });

  it('shows the five advanced groups, but not Output and Expert until one more click', async () => {
    render(<Harness />);
    await openAdvanced();
    for (const name of ['Motion', 'Transitions', 'Captions', 'Backdrop and effects', 'Audio'])
      expect(screen.getByRole('group', { name })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Output' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Expert JSON' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show output & expert' }));
    expect(screen.getByRole('group', { name: 'Output' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Expert JSON' })).toBeInTheDocument();
  });

  it('shows every field’s default and one-line note', async () => {
    render(<Harness />);
    await openAdvanced();
    const zoom = FIELDS.find((f) => f.path === 'motion.zoomAmount')!;
    const field = screen.getByTestId('field-motion.zoomAmount');
    expect(within(field).getByText('Default: 1.15')).toBeInTheDocument();
    expect(within(field).getByText(zoom.note)).toBeInTheDocument();
    const advancedFields = FIELDS.filter((f) => f.tier === 'advanced');
    expect(advancedFields.every((f) => screen.queryByTestId(`field-${f.path}`))).toBe(true);
  });

  it('edits a field, marks it changed against the preset, and shows disabled reasons', async () => {
    render(<Harness />);
    await openAdvanced();
    const input = screen.getByRole('slider', { name: 'Zoom amount' });
    fireEvent.change(input, { target: { value: '1.3' } });
    expect(readConfig().motion.zoomAmount).toBe(1.3);
    expect(
      within(screen.getByTestId('field-motion.zoomAmount')).getByText('Changed'),
    ).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Samples' })).toBeDisabled();
    expect(
      within(screen.getByTestId('field-motion.motionBlur.samples')).getByText(
        'Motion blur is off.',
      ),
    ).toBeInTheDocument();
  });

  it('shows a live spring curve preview', async () => {
    render(<Harness />);
    await openAdvanced();
    expect(screen.getByRole('img', { name: /spring curve/i })).toBeInTheDocument();
  });

  it('offers only exposed transitions', async () => {
    render(<Harness />);
    await openAdvanced();
    const presentations = screen.getByRole('group', { name: 'Presentations' });
    expect(
      within(presentations).queryByRole('checkbox', { name: 'Ripple' }),
    ).not.toBeInTheDocument();
    expect(within(presentations).getByRole('checkbox', { name: 'Dissolve' })).toBeInTheDocument();
  });

  it('warns about valid-but-awful combinations without blocking them', async () => {
    render(<Harness />);
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Aspect' })).getByRole('radio', { name: '9:16' }),
    );
    await openAdvanced();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Letterbox' }));
    expect(readConfig().backdrop.letterbox.enabled).toBe(true);
    const summary = screen.getByRole('region', { name: 'Warnings' });
    expect(within(summary).getByText(/thin strip of picture/i)).toBeInTheDocument();
    expect(
      within(screen.getByTestId('field-backdrop.letterbox.enabled')).getByText(
        /thin strip of picture/i,
      ),
    ).toBeInTheDocument();
  });

  it('offers Undo after an animation kind resets custom settings', async () => {
    render(<Harness />);
    await openAdvanced();
    fireEvent.change(screen.getByRole('slider', { name: 'Zoom amount' }), {
      target: { value: '1.33' },
    });
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Animation' }), 'calm');
    expect(readConfig().motion.zoomAmount).not.toBe(1.33);
    expect(screen.getByRole('status')).toHaveTextContent('Reset 1 custom setting');
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(readConfig().motion.zoomAmount).toBe(1.33);
    expect(readConfig().simple.animationKind).toBe('documentary');
  });
});

describe('Output and Expert (one more click)', () => {
  const openOutput = async () => {
    await openAdvanced();
    await userEvent.click(screen.getByRole('button', { name: 'Show output & expert' }));
  };

  it('disables hardware acceleration while a CRF is set, and CRF while acceleration is on', async () => {
    render(<Harness />);
    await openOutput();
    const crf = screen.getByRole('spinbutton', { name: 'CRF' });
    await userEvent.type(crf, '22');
    expect(readConfig().output.crf).toBe(22);
    expect(screen.getByRole('group', { name: 'Hardware acceleration' })).toBeDisabled();
    expect(
      within(screen.getByTestId('field-output.hardwareAcceleration')).getByText(/clear the crf/i),
    ).toBeInTheDocument();
    await userEvent.clear(crf);
    expect(readConfig().output.crf).toBeNull();
    await userEvent.click(
      within(screen.getByRole('group', { name: 'Hardware acceleration' })).getByRole('radio', {
        name: 'If possible',
      }),
    );
    expect(screen.getByRole('spinbutton', { name: 'CRF' })).toBeDisabled();
    expect(
      within(screen.getByTestId('field-output.crf')).getByText(/hardware acceleration is on/i),
    ).toBeInTheDocument();
  });

  it('resets a CRF the new codec cannot take, and the x264 preset off h264', async () => {
    render(<Harness />);
    await openOutput();
    await userEvent.type(screen.getByRole('spinbutton', { name: 'CRF' }), '2');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'x264 preset' }), 'slow');
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Codec' }), 'vp8');
    expect(readConfig().output).toMatchObject({ codec: 'vp8', crf: null, x264Preset: null });
    expect(screen.getByRole('combobox', { name: 'x264 preset' })).toBeDisabled();
  });

  it('applies valid raw JSON and reports invalid JSON by line and by field path', async () => {
    render(<Harness />);
    await openOutput();
    const editor = screen.getByRole('textbox', { name: 'Expert JSON' });
    fireEvent.change(editor, { target: { value: '{\n  "version": 1,\n  "simple": {\n}' } });
    await userEvent.click(screen.getByRole('button', { name: 'Apply JSON' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/line \d+/i);
    const json = JSON.parse(JSON.stringify(initialConfig()));
    json.simple.mood = 'happy';
    fireEvent.change(editor, { target: { value: JSON.stringify(json, null, 2) } });
    await userEvent.click(screen.getByRole('button', { name: 'Apply JSON' }));
    expect(screen.getByRole('alert')).toHaveTextContent('simple');
    delete json.simple.mood;
    json.motion.zoomAmount = 1.25;
    fireEvent.change(editor, { target: { value: JSON.stringify(json, null, 2) } });
    await userEvent.click(screen.getByRole('button', { name: 'Apply JSON' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(readConfig().motion.zoomAmount).toBe(1.25);
  });
});
