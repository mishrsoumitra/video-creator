import {
  BUILT_IN_PRESETS,
  SettingsSchema,
  TRANSITION_NAMES,
  exposedTransitions,
  initialConfig,
  type CatalogProvider,
  type CatalogResponse,
  type EstimateResponse,
  type JobDetail,
  type Preset,
  type RoleId,
  type RoleSlot,
  type ScenePlan,
  type SetupState,
} from '@vc/config';

const opts = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const role = (
  defaultModel: string,
  suggestedModels: string[] = [defaultModel],
  optionsSchema = opts({}),
  label = 'Adapter',
) => ({
  label,
  defaultModel,
  suggestedModels,
  optionsSchema,
});

export const providers: CatalogProvider[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'cloud',
    description: 'GPT models, web search, TTS and whisper-1.',
    credential: {
      id: 'openai',
      label: 'OpenAI API key',
      helpUrl: 'https://platform.openai.com/api-keys',
      optional: false,
    },
    roles: {
      text: role(
        'gpt-6.1-sol',
        ['gpt-6.1-sol', 'gpt-6.1-mini'],
        opts({ reasoningEffort: { type: 'string', enum: ['low', 'medium', 'high'] } }),
      ),
      search: role('gpt-6.1-sol'),
      voice: role(
        'gpt-4o-mini-tts',
        ['gpt-4o-mini-tts', 'tts-1'],
        opts({
          voice: { type: 'string', enum: ['alloy', 'marin'], default: 'marin' },
          speed: { type: 'number', minimum: 0.25, maximum: 4 },
        }),
      ),
      align: role('whisper-1'),
      vision: role('gpt-6.1-sol'),
    },
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    kind: 'cloud',
    description: 'Claude models with web search.',
    credential: {
      id: 'anthropic',
      label: 'Anthropic API key',
      helpUrl: 'https://console.anthropic.com/',
      optional: false,
    },
    roles: {
      text: role(
        'claude-opus-5-5',
        ['claude-opus-5-5', 'claude-sonnet-5-5'],
        opts({ refusalFallback: { type: 'boolean', default: true } }),
      ),
      search: role('claude-opus-5-5'),
      vision: role('claude-opus-5-5'),
    },
  },
  {
    id: 'openai-compatible',
    label: 'Local model (Ollama / LM Studio)',
    kind: 'local',
    description: 'Any OpenAI-compatible endpoint on this machine.',
    credential: {
      id: 'openai-compatible',
      label: 'Local server key',
      helpUrl: 'https://ollama.com',
      optional: true,
    },
    roles: {
      text: role('qwen3:8b', ['qwen3:8b'], opts({ baseUrl: { type: 'string', format: 'uri' } })),
      vision: role('gemma3:12b'),
    },
  },
  {
    id: 'brave',
    label: 'Brave Search',
    kind: 'cloud',
    description: 'Plain search API, no model.',
    credential: {
      id: 'brave',
      label: 'Brave Search API key',
      helpUrl: 'https://brave.com/search/api/',
      optional: false,
    },
    roles: { search: role('brave-web-search') },
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    kind: 'cloud',
    description: 'TTS that returns character timings.',
    credential: {
      id: 'elevenlabs',
      label: 'ElevenLabs API key',
      helpUrl: 'https://elevenlabs.io',
      optional: false,
    },
    roles: {
      voice: role(
        'eleven_multilingual_v2',
        ['eleven_multilingual_v2'],
        opts({ voiceId: { type: 'string', default: 'JBFqnCBsd6RMkjVDRZzb' } }),
      ),
    },
  },
  {
    id: 'azure-tts',
    label: 'Azure Neural TTS',
    kind: 'cloud',
    description: 'Azure speech.',
    credential: {
      id: 'azure-speech',
      label: 'Azure Speech key',
      helpUrl: 'https://azure.microsoft.com',
      optional: false,
    },
    roles: {
      voice: role(
        'en-US-AndrewMultilingualNeural',
        ['en-US-AndrewMultilingualNeural'],
        opts({ region: { type: 'string' } }, ['region']),
      ),
    },
  },
  {
    id: 'kokoro',
    label: 'Kokoro-82M (local)',
    kind: 'local',
    description: 'Runs on this machine.',
    credential: null,
    roles: { voice: role('onnx-community/Kokoro-82M-v1.0-ONNX') },
  },
  {
    id: 'whisper-cpp',
    label: 'whisper.cpp (local)',
    kind: 'local',
    description: 'Runs on this machine.',
    credential: null,
    roles: { align: role('base.en', ['base.en', 'small.en']) },
  },
];

const untested = {
  status: 'untested',
  at: null,
  model: null,
  detail: null,
  durationMs: null,
} as const;
const passed = (model: string) =>
  ({ status: 'passed', at: '2026-10-18T10:00:00Z', model, detail: 'OK', durationMs: 412 }) as const;

const slot = (r: RoleId, patch: Partial<RoleSlot> = {}): RoleSlot => ({
  role: r,
  mode: 'provider',
  providerId: null,
  model: null,
  options: {},
  test: { ...untested },
  ...patch,
});

export const completeSetup = (): SetupState => ({
  complete: true,
  missing: [],
  roles: {
    text: slot('text', {
      providerId: 'openai',
      model: 'gpt-6.1-sol',
      test: { ...passed('gpt-6.1-sol-2026-09-01') },
    }),
    search: slot('search', {
      providerId: 'brave',
      model: 'brave-web-search',
      test: { ...passed('brave-web-search') },
    }),
    voice: slot('voice', {
      providerId: 'elevenlabs',
      model: 'eleven_multilingual_v2',
      test: { ...passed('eleven_multilingual_v2') },
    }),
    align: slot('align', { mode: 'off' }),
    vision: slot('vision', { mode: 'off' }),
  },
  credentials: [
    {
      id: 'openai',
      label: 'OpenAI API key',
      masked: '••••abcd',
      updatedAt: '2026-10-18T09:00:00Z',
    },
    {
      id: 'brave',
      label: 'Brave Search API key',
      masked: '••••wxyz',
      updatedAt: '2026-10-18T09:00:00Z',
    },
    {
      id: 'elevenlabs',
      label: 'ElevenLabs API key',
      masked: '••••1234',
      updatedAt: '2026-10-18T09:00:00Z',
    },
  ],
  vault: { backend: 'keychain', locked: false, needsSetup: false },
});

export const emptySetup = (): SetupState => ({
  complete: false,
  missing: [
    { role: 'text', reason: 'Choose a text provider and pass the test call.' },
    { role: 'voice', reason: 'Choose a voice or switch to uploading recordings.' },
  ],
  roles: {
    text: slot('text'),
    search: slot('search'),
    voice: slot('voice'),
    align: slot('align'),
    vision: slot('vision', { mode: 'off' }),
  },
  credentials: [],
  vault: { backend: 'keychain', locked: false, needsSetup: false },
});

export const catalogResponse = (): CatalogResponse => ({
  exposedTransitions: exposedTransitions(new Set()),
  timedTransitions: [],
  fonts: ['Inter', 'Roboto', 'Playfair Display'],
  musicTracks: [
    { id: 'soft-pad', label: 'Soft pad', mood: 'calm' },
    { id: 'pulse', label: 'Pulse', mood: 'energetic' },
    { id: 'drone', label: 'Drone', mood: 'cinematic' },
  ],
  platform: 'darwin',
  cpuCount: 8,
});

export const allTransitionsTimed = (): CatalogResponse => ({
  ...catalogResponse(),
  exposedTransitions: [...TRANSITION_NAMES],
  timedTransitions: ['crosswarp', 'ripple', 'film-burn', 'book-flip'],
});

export const userPreset = (): Preset => ({
  id: 'my-channel-look',
  name: 'My Channel Look',
  description: 'Warm and calm',
  builtIn: false,
  config: { ...structuredClone(BUILT_IN_PRESETS[1]!.config), basedOnPreset: 'calm-explainer' },
});

export const presetsResponse = (): Preset[] => [
  ...(structuredClone(BUILT_IN_PRESETS) as Preset[]),
  userPreset(),
];

export const settingsResponse = () => SettingsSchema.parse({});

export const estimateResponse = (patch: Partial<EstimateResponse> = {}): EstimateResponse => ({
  cost: {
    totalUsd: 0.0523,
    maxUsd: 0.1311,
    lines: [
      {
        stage: 'script',
        role: 'text',
        providerId: 'openai',
        model: 'gpt-6.1-sol',
        usd: 0.012,
        maxUsd: 0.024,
        note: 'Script to the word budget',
      },
      {
        stage: 'voice',
        role: 'voice',
        providerId: 'elevenlabs',
        model: 'eleven_multilingual_v2',
        usd: 0.04,
        maxUsd: 0.04,
        note: 'Narration (TTS)',
      },
    ],
    unpriced: [],
    capUsd: 2,
  },
  render: {
    status: 'ok',
    seconds: 95,
    lowSeconds: 70,
    highSeconds: 130,
    unmeasured: [],
    sampleCount: 12,
  },
  ...patch,
});

export const plan = (): ScenePlan => ({
  version: 1,
  title: 'One giant leap',
  durationMs: 6000,
  scenes: [
    {
      id: 's1',
      startMs: 0,
      endMs: 3000,
      narration: 'Apollo eleven landed in 1969.',
      visual: {
        type: 'image',
        src: '/api/jobs/job1/assets/scene-01.jpg',
        width: 1920,
        height: 1080,
        credit: null,
      },
      captionPlacement: 'bottom',
    },
    {
      id: 's2',
      startMs: 3000,
      endMs: 6000,
      narration: 'Twelve people walked on the Moon.',
      visual: { type: 'typographic', text: 'Twelve People' },
      captionPlacement: 'bottom',
    },
  ],
  words: [
    { text: 'Apollo', startMs: 0, endMs: 400 },
    { text: 'eleven', startMs: 450, endMs: 900 },
  ],
  audio: { narrationSrc: '/api/jobs/job1/assets/narration.wav', musicSrc: null },
  palette: null,
  fonts: { caption: { fontFamily: 'Inter', importName: 'Inter' } },
});

export const jobDetail = (patch: Partial<JobDetail> = {}): JobDetail => ({
  id: 'job1',
  topic: 'The Apollo program',
  lengthSeconds: 60,
  status: 'review',
  createdAt: '2026-10-18T10:00:00Z',
  updatedAt: '2026-10-18T10:02:00Z',
  costUsd: 0.0412,
  stage: 'captions',
  stages: [
    {
      stage: 'research',
      status: 'done',
      detail: null,
      startedAt: '2026-10-18T10:00:01Z',
      finishedAt: '2026-10-18T10:00:20Z',
    },
    {
      stage: 'script',
      status: 'done',
      detail: null,
      startedAt: '2026-10-18T10:00:20Z',
      finishedAt: '2026-10-18T10:00:40Z',
    },
    {
      stage: 'voice',
      status: 'done',
      detail: null,
      startedAt: '2026-10-18T10:00:40Z',
      finishedAt: '2026-10-18T10:01:00Z',
    },
    { stage: 'render', status: 'pending', detail: null, startedAt: null, finishedAt: null },
  ],
  config: initialConfig(),
  plan: plan(),
  warnings: ['1 scene(s) use a typographic card because no image passed.'],
  error: null,
  aiCalls: [
    {
      id: 'job1-1',
      stage: 'research',
      role: 'search',
      providerId: 'brave',
      model: 'search-api',
      reason: 'Plain search API for source pages (not AI).',
      ai: false,
      required: true,
      status: 'ok',
      units: { searches: 1 },
      costUsd: 0.005,
      priced: true,
      startedAt: '2026-10-18T10:00:02Z',
      durationMs: 320,
    },
    {
      id: 'job1-2',
      stage: 'script',
      role: 'text',
      providerId: 'openai',
      model: 'gpt-6.1-sol-2026-09-01',
      reason: 'Writing narration to a word budget with a story shape needs a language model.',
      ai: true,
      required: true,
      status: 'ok',
      units: { inputTokens: 1800, outputTokens: 400 },
      costUsd: 0.0076,
      priced: true,
      startedAt: '2026-10-18T10:00:21Z',
      durationMs: 9100,
    },
    {
      id: 'job1-3',
      stage: 'images',
      role: 'vision',
      providerId: 'openai',
      model: 'gpt-6.1-sol',
      reason:
        'Best deterministic score 0.41 is below the threshold 0.65; the vision model ranks the top 6.',
      ai: true,
      required: false,
      status: 'skipped-cap',
      units: { images: 6 },
      costUsd: 0,
      priced: true,
      startedAt: '2026-10-18T10:01:10Z',
      durationMs: 0,
    },
  ],
  cost: { estimatedUsd: 0.0523, actualUsd: 0.0126, capUsd: 2 },
  render: {
    estimate: {
      status: 'uncalibrated',
      seconds: null,
      lowSeconds: null,
      highSeconds: null,
      unmeasured: [],
      sampleCount: 0,
    },
    elapsedMs: null,
    progress: null,
    renders: 0,
  },
  outputs: { video: null, srt: null, credits: null, contactSheet: null },
  checks: [],
  imageDecisions: [
    {
      sceneIndex: 0,
      query: 'Saturn V rocket launch',
      method: 'deterministic',
      bestScore: 0.81,
      chosenId: 'abc',
      reason: 'Deterministic score 0.81 ≥ threshold 0.65.',
    },
    {
      sceneIndex: 1,
      query: 'twelve astronauts moon',
      method: 'fallback',
      bestScore: 0.3,
      chosenId: null,
      reason: 'No candidate is relevant enough.',
    },
  ],
  hasRecording: false,
  sourceTextProvided: false,
  ...patch,
});
