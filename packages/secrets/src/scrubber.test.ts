import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { SecretScrubber, createScrubbingStream } from './index';

const KEY = 'sk-live-ABCDEFGH12345678';

describe('SecretScrubber', () => {
  it('replaces every raw occurrence of a registered secret', () => {
    const s = new SecretScrubber();
    s.add(KEY);
    expect(s.scrub(`key=${KEY} and again ${KEY}.`)).toBe('key=[REDACTED] and again [REDACTED].');
  });

  it('replaces the URL-encoded form', () => {
    const s = new SecretScrubber();
    const key = 'abc/def+ghi=jkl==';
    s.add(key);
    const url = `https://serpapi.com/search.json?api_key=${encodeURIComponent(key)}&q=x`;
    expect(s.scrub(url)).toBe('https://serpapi.com/search.json?api_key=[REDACTED]&q=x');
  });

  it('replaces the base64 form', () => {
    const s = new SecretScrubber();
    s.add(KEY);
    const b64 = Buffer.from(KEY).toString('base64');
    expect(s.scrub(`Authorization: Basic ${b64}`)).toBe('Authorization: Basic [REDACTED]');
  });

  it('ignores values shorter than eight characters so logs are not shredded', () => {
    const s = new SecretScrubber();
    expect(s.add('short')).toBe(false);
    expect(s.add('')).toBe(false);
    expect(s.scrub('a short story')).toBe('a short story');
    expect(s.size).toBe(0);
  });

  it('replaces the longest secret first when one contains another', () => {
    const s = new SecretScrubber();
    s.add('abcdefghij');
    s.add('abcdefghijKLMNOP');
    expect(s.scrub('x abcdefghijKLMNOP y abcdefghij z')).toBe('x [REDACTED] y [REDACTED] z');
  });

  it('treats regex metacharacters in a secret literally', () => {
    const s = new SecretScrubber();
    const key = 'a.b*c+d?e(f)[g]{h}^$|\\';
    s.add(key);
    expect(s.scrub(`literal ${key} end`)).toBe('literal [REDACTED] end');
    expect(s.scrub('aXbXXc+d?e(f)[g]{h}^$|\\')).toBe('aXbXXc+d?e(f)[g]{h}^$|\\');
  });

  it('stops scrubbing removed secrets and supports clear()', () => {
    const s = new SecretScrubber();
    s.add(KEY);
    s.add('another-secret-value');
    s.remove(KEY);
    expect(s.scrub(KEY)).toBe(KEY);
    expect(s.scrub('another-secret-value')).toBe('[REDACTED]');
    s.clear();
    expect(s.scrub('another-secret-value')).toBe('another-secret-value');
  });

  it('is idempotent when the same secret is added twice', () => {
    const s = new SecretScrubber();
    expect(s.add(KEY)).toBe(true);
    expect(s.add(KEY)).toBe(true);
    expect(s.size).toBe(1);
  });

  it('returns text without secrets unchanged', () => {
    const s = new SecretScrubber();
    s.add(KEY);
    const text = 'nothing to see here';
    expect(s.scrub(text)).toBe(text);
  });
});

const collect = () => {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  return { sink, text: () => chunks.join('') };
};

const end = (stream: Writable) => new Promise<void>((resolve) => stream.end(resolve));

describe('createScrubbingStream (the log destination)', () => {
  it('scrubs secrets in every line it passes through', async () => {
    const s = new SecretScrubber();
    s.add(KEY);
    const { sink, text } = collect();
    const stream = createScrubbingStream(sink, s);
    stream.write(`{"msg":"calling","key":"${KEY}"}\n`);
    stream.write('{"msg":"plain"}\n');
    await end(stream);
    expect(text()).toBe('{"msg":"calling","key":"[REDACTED]"}\n{"msg":"plain"}\n');
  });

  it('scrubs a secret split across two writes of the same line', async () => {
    const s = new SecretScrubber();
    s.add(KEY);
    const { sink, text } = collect();
    const stream = createScrubbingStream(sink, s);
    stream.write(`error: ${KEY.slice(0, 10)}`);
    stream.write(`${KEY.slice(10)} failed\n`);
    await end(stream);
    expect(text()).toBe('error: [REDACTED] failed\n');
  });

  it('flushes a trailing partial line on end, scrubbed', async () => {
    const s = new SecretScrubber();
    s.add(KEY);
    const { sink, text } = collect();
    const stream = createScrubbingStream(sink, s);
    stream.write(Buffer.from(`last ${KEY}`));
    await end(stream);
    expect(text()).toBe('last [REDACTED]');
  });

  it('picks up secrets registered after the stream was created', async () => {
    const s = new SecretScrubber();
    const through = new PassThrough();
    const out: string[] = [];
    through.on('data', (d: Buffer) => out.push(d.toString()));
    const stream = createScrubbingStream(through, s);
    s.add(KEY);
    stream.write(`${KEY}\n`);
    await end(stream);
    expect(out.join('')).toBe('[REDACTED]\n');
  });
});
