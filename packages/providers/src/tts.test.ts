import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { azureTtsProvider, escapeXml } from './azure-tts';
import { elevenlabsProvider } from './elevenlabs';
import { googleTtsProvider } from './google-tts';
import { createRoleProvider } from './registry';
import {
  createFakeFetch,
  jsonResponse,
  pcmBytes,
  sinePcm,
  type FakeHandler,
} from './testing/fake-fetch';
import { decodeWav, durationSeconds, encodeWav } from './wav';

const voice = (
  providerId: string,
  handler: FakeHandler | FakeHandler[],
  extra: { model?: string; options?: Record<string, unknown>; apiKey?: string } = {},
) => {
  const fake = createFakeFetch(handler);
  const provider = createRoleProvider({
    providerId,
    role: 'voice',
    apiKey: extra.apiKey ?? 'key-0123456789-test',
    dataDir: tmpdir(),
    fetch: fake.fetch,
    ...extra,
  });
  return { fake, provider };
};

const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

describe('elevenlabs (with-timestamps)', () => {
  const alignmentFor = (text: string, offset = 0) => ({
    characters: [...text],
    character_start_times_seconds: [...text].map((_, i) => offset + i * 0.05),
    character_end_times_seconds: [...text].map((_, i) => offset + i * 0.05 + 0.05),
  });

  it('requests PCM with timestamps and returns audio plus character alignment', async () => {
    const pcm = sinePcm(1);
    const { fake, provider } = voice('elevenlabs', () =>
      jsonResponse({
        audio_base64: base64(pcmBytes(pcm)),
        alignment: alignmentFor('Hi you'),
        normalized_alignment: alignmentFor('hi you'),
      }),
    );
    const result = await provider.synthesize({ text: 'Hi you' });
    const req = fake.requests[0]!;
    expect(req.url.origin + req.url.pathname).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb/with-timestamps',
    );
    expect(req.url.searchParams.get('output_format')).toBe('pcm_24000');
    expect(req.headers.get('xi-api-key')).toBe('key-0123456789-test');
    expect(req.json).toMatchObject({ text: 'Hi you', model_id: 'eleven_multilingual_v2' });
    expect(provider.returnsTimings).toBe(true);
    expect(result.value.alignment).toEqual({
      characters: [...'Hi you'],
      startTimesSeconds: [0, 0.05, 0.1, 0.15, 0.2, 0.25].map((n) => expect.closeTo(n, 6)),
      endTimesSeconds: [0.05, 0.1, 0.15, 0.2, 0.25, 0.3].map((n) => expect.closeTo(n, 6)),
    });
    expect(decodeWav(result.value.audio).sampleRate).toBe(24_000);
    expect(result.usage).toEqual({ characters: 6, audioSeconds: 1 });
  });

  it('splits text over the model limit, sends neighbouring text for continuity, and offsets the timings', async () => {
    const sentence = 'Short sentence here. ';
    const text = sentence.repeat(300).trim(); // ~6,300 chars > eleven_v3's 5,000
    const handler: FakeHandler = (request) => {
      const chunk = (request.json as { text: string }).text;
      return jsonResponse({
        audio_base64: base64(pcmBytes(sinePcm(2))),
        alignment: alignmentFor(chunk),
      });
    };
    const { fake, provider } = voice('elevenlabs', handler, { model: 'eleven_v3' });
    const result = await provider.synthesize({ text });
    expect(fake.requests).toHaveLength(2);
    const [first, second] = fake.requests.map(
      (r) => r.json as { text: string; previous_text?: string; next_text?: string },
    );
    expect(first!.text.length).toBeLessThanOrEqual(5000);
    expect(first!.next_text).toBe(second!.text);
    expect(second!.previous_text).toBe(first!.text);
    const alignment = result.value.alignment!;
    expect(alignment.characters.join('')).toBe(text);
    const boundary = first!.text.length; // the joining space
    expect(alignment.startTimesSeconds[boundary + 1]).toBeCloseTo(2, 6);
    expect(durationSeconds(decodeWav(result.value.audio))).toBeCloseTo(4, 6);
  });

  it('returns null alignment when the API omits it, so the pipeline falls back to forced alignment', async () => {
    const { provider } = voice('elevenlabs', () =>
      jsonResponse({ audio_base64: base64(pcmBytes(sinePcm(0.2))), alignment: null }),
    );
    expect((await provider.synthesize({ text: 'x' })).value.alignment).toBeNull();
  });

  it('rejects a voice id that could escape the URL path', () => {
    expect(() => voice('elevenlabs', [], { options: { voiceId: '../../v1/user' } })).toThrow();
  });

  it('prices premium and fast models differently', () => {
    const pricing = elevenlabsProvider.roles.voice!.pricing;
    expect(pricing('eleven_multilingual_v2')).toMatchObject({ perMChars: 80 });
    expect(pricing('eleven_flash_v2_5')).toMatchObject({ perMChars: 40 });
  });
});

describe('google cloud text-to-speech', () => {
  it('sends LINEAR16 at 24 kHz with the voice name, and decodes the WAV it returns', async () => {
    const wav = encodeWav({ sampleRate: 24_000, channels: 1, samples: sinePcm(0.5) });
    const { fake, provider } = voice('google-tts', () =>
      jsonResponse({ audioContent: base64(wav) }),
    );
    const result = await provider.synthesize({ text: 'Hello there.' });
    const req = fake.requests[0]!;
    expect(req.url.href).toBe('https://texttospeech.googleapis.com/v1/text:synthesize');
    expect(req.headers.get('x-goog-api-key')).toBe('key-0123456789-test');
    expect(req.json).toEqual({
      input: { text: 'Hello there.' },
      voice: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Charon' },
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24_000 },
    });
    expect(durationSeconds(decodeWav(result.value.audio))).toBeCloseTo(0.5, 6);
    expect(result.usage.characters).toBe(12);
  });

  it('keeps every request under the 5,000-byte input limit', async () => {
    const wav = encodeWav({ sampleRate: 24_000, channels: 1, samples: sinePcm(0.1) });
    const text = 'Café crème brûlée façade. '.repeat(400);
    const { fake, provider } = voice('google-tts', () =>
      jsonResponse({ audioContent: base64(wav) }),
    );
    await provider.synthesize({ text });
    expect(fake.requests.length).toBeGreaterThan(1);
    for (const r of fake.requests)
      expect(
        new TextEncoder().encode((r.json as { input: { text: string } }).input.text).length,
      ).toBeLessThanOrEqual(5000);
  });

  it('prices by voice family', () => {
    const pricing = googleTtsProvider.roles.voice!.pricing;
    expect(pricing('en-US-Neural2-D')).toMatchObject({ perMChars: 16 });
    expect(pricing('en-US-Standard-B')).toMatchObject({ perMChars: 4 });
    expect(pricing('en-US-Studio-O')).toMatchObject({ perMChars: 160 });
    expect(pricing('en-US-Chirp3-HD-Charon')).toMatchObject({ perMChars: 30 });
  });
});

describe('azure neural text-to-speech', () => {
  it('posts escaped SSML to the regional host with the subscription key', async () => {
    const wav = encodeWav({ sampleRate: 24_000, channels: 1, samples: sinePcm(0.3) });
    const { fake, provider } = voice(
      'azure-tts',
      () => new Response(wav, { headers: { 'content-type': 'audio/wav' } }),
      { options: { region: 'westeurope' } },
    );
    await provider.synthesize({ text: 'Tom & Jerry <say> "hi"' });
    const req = fake.requests[0]!;
    expect(req.url.href).toBe('https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1');
    expect(req.headers.get('ocp-apim-subscription-key')).toBe('key-0123456789-test');
    expect(req.headers.get('x-microsoft-outputformat')).toBe('riff-24khz-16bit-mono-pcm');
    expect(req.headers.get('content-type')).toBe('application/ssml+xml');
    expect(req.bodyText).toContain(
      '<voice name="en-US-AndrewMultilingualNeural">Tom &amp; Jerry &lt;say&gt; &quot;hi&quot;</voice>',
    );
    expect(req.bodyText).toContain('xml:lang="en-US"');
  });

  it('requires a valid region, so the key can only go to a Microsoft host', () => {
    expect(() => voice('azure-tts', [], {})).toThrow();
    expect(() => voice('azure-tts', [], { options: { region: 'evil.com#' } })).toThrow();
    expect(azureTtsProvider.allowedHosts({ region: 'eastus' })).toEqual([
      'eastus.tts.speech.microsoft.com',
    ]);
  });

  it('escapes all five XML special characters', () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;',
    );
  });
});
