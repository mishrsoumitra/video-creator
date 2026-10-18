import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPageFetcher,
  createSafeDownloader,
  htmlToReadableText,
  isBlockedAddress,
} from './page-fetcher';

type Route = (req: { url: string; headers: IncomingHttpHeaders }) => {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  delayMs?: number;
};

const routes = new Map<string, Route>();
const seen: Array<{ url: string; headers: IncomingHttpHeaders }> = [];
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    const fallback: Route = () => ({ status: 404, body: 'missing' });
    const route = routes.get(req.url ?? '') ?? fallback;
    const out = route({ url: req.url ?? '', headers: req.headers });
    const send = () => {
      res.writeHead(
        out.status ?? 200,
        out.headers ?? { 'content-type': 'text/html; charset=utf-8' },
      );
      res.end(out.body ?? '');
    };
    if (out.delayMs) setTimeout(send, out.delayMs);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** site.test → 127.0.0.1 through the injected lookup; only this test allows a loopback address. */
const testFetcher = (extra: Partial<Parameters<typeof createPageFetcher>[0]> = {}) =>
  createPageFetcher({
    lookup: async (host) => {
      if (host === 'site.test' || host === 'other.test')
        return [{ address: '127.0.0.1', family: 4 }];
      if (host === 'internal.test') return [{ address: '10.0.0.7', family: 4 }];
      if (host === 'mixed.test')
        return [
          { address: '93.184.216.34', family: 4 },
          { address: '192.168.0.10', family: 4 },
        ];
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    },
    isAddressAllowed: (address) => address === '127.0.0.1',
    ...extra,
  });

const article = `<!doctype html><html><head><title>Apollo program</title></head><body>
  <nav>Home | About | Contact</nav>
  <article><h1>The Apollo program</h1>
  <p>${'The Apollo program landed twelve astronauts on the Moon between 1969 and 1972. '.repeat(6)}</p>
  <p>The Saturn V remains the most powerful rocket ever flown.</p></article>
  <script>trackEverything()</script><footer>© 2026</footer></body></html>`;

describe('page fetcher', () => {
  it('fetches through the pinned lookup and extracts readable text with block breaks', async () => {
    routes.set('/apollo', () => ({ body: article }));
    const page = await testFetcher().fetchPage(`http://site.test:${port}/apollo`);
    expect(page.url).toBe(`http://site.test:${port}/apollo`);
    expect(page.title).toBe('Apollo program');
    expect(page.text).toContain('The Apollo program landed twelve astronauts');
    expect(page.text).toMatch(/1972\.\s*\n+\s*The Saturn V/);
    expect(page.text).not.toContain('trackEverything');
    expect(page.text).not.toMatch(/HomeThe/);
  });

  it('sends no cookies or credentials, and identifies itself', async () => {
    routes.set('/headers', () => ({ body: article }));
    await testFetcher().fetchPage(`http://site.test:${port}/headers`);
    const request = seen.at(-1)!;
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers['user-agent']).toMatch(/video-creator/);
  });

  it('passes plain text through', async () => {
    routes.set('/notes.txt', () => ({
      headers: { 'content-type': 'text/plain' },
      body: 'Line one.\nLine two.',
    }));
    const page = await testFetcher().fetchPage(`http://site.test:${port}/notes.txt`);
    expect(page.text).toBe('Line one.\nLine two.');
    expect(page.title).toBe('notes.txt');
  });

  it('refuses things that are not web pages', async () => {
    routes.set('/doc.pdf', () => ({
      headers: { 'content-type': 'application/pdf' },
      body: '%PDF',
    }));
    await expect(testFetcher().fetchPage(`http://site.test:${port}/doc.pdf`)).rejects.toMatchObject(
      { code: 'unsupported' },
    );
  });

  it('follows relative and absolute redirects', async () => {
    routes.set('/r1', () => ({ status: 301, headers: { location: '/r2' } }));
    routes.set('/r2', () => ({
      status: 302,
      headers: { location: `http://other.test:${port}/final` },
    }));
    routes.set('/final', () => ({ body: article }));
    const page = await testFetcher().fetchPage(`http://site.test:${port}/r1`);
    expect(page.url).toBe(`http://other.test:${port}/final`);
  });

  it('re-checks every redirect hop and refuses one that lands on a private address', async () => {
    routes.set('/to-internal', () => ({
      status: 302,
      headers: { location: 'http://internal.test/admin' },
    }));
    await expect(
      testFetcher().fetchPage(`http://site.test:${port}/to-internal`),
    ).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringMatching(/private|local/i),
    });
  });

  it('stops after five redirects', async () => {
    routes.set('/loop', () => ({ status: 302, headers: { location: '/loop' } }));
    await expect(testFetcher().fetchPage(`http://site.test:${port}/loop`)).rejects.toThrow(
      /redirect/i,
    );
  });

  it('caps the decompressed body at the byte limit', async () => {
    routes.set('/huge', () => ({
      headers: { 'content-type': 'text/plain' },
      body: 'a'.repeat(3 * 1024 * 1024),
    }));
    const page = await testFetcher({ maxBytes: 64 * 1024 }).fetchPage(
      `http://site.test:${port}/huge`,
    );
    expect(page.text.length).toBeLessThanOrEqual(64 * 1024);
  });

  it('decompresses gzip and applies the cap to the decompressed size (zip bombs)', async () => {
    const bomb = gzipSync(Buffer.from('b'.repeat(5 * 1024 * 1024)));
    routes.set('/bomb', () => ({
      headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
      body: bomb,
    }));
    const page = await testFetcher({ maxBytes: 32 * 1024 }).fetchPage(
      `http://site.test:${port}/bomb`,
    );
    expect(page.text.length).toBeLessThanOrEqual(32 * 1024);
    expect(page.text.startsWith('bbbb')).toBe(true);
  });

  it('decodes the declared charset', async () => {
    routes.set('/latin1', () => ({
      headers: { 'content-type': 'text/plain; charset=iso-8859-1' },
      body: Buffer.from([0x63, 0x61, 0x66, 0xe9]),
    }));
    expect((await testFetcher().fetchPage(`http://site.test:${port}/latin1`)).text).toBe('café');
  });

  it('times out slow servers', async () => {
    routes.set('/slow', () => ({ body: article, delayMs: 500 }));
    await expect(
      testFetcher({ timeoutMs: 50 }).fetchPage(`http://site.test:${port}/slow`),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('maps HTTP errors', async () => {
    await expect(testFetcher().fetchPage(`http://site.test:${port}/nope`)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('with the default policy, refuses loopback before any connection is made', async () => {
    const before = seen.length;
    await expect(
      createPageFetcher().fetchPage(`http://127.0.0.1:${port}/apollo`),
    ).rejects.toMatchObject({ code: 'bad_request' });
    await expect(
      createPageFetcher({ lookup: async () => [{ address: '127.0.0.1', family: 4 }] }).fetchPage(
        `http://site.test:${port}/apollo`,
      ),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(seen.length).toBe(before);
  });

  it.each([
    'ftp://example.com/file',
    'file:///etc/passwd',
    'http://user:pass@example.com/',
    'http://localhost/',
    'http://intranet/',
    'http://printer.local/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[fd00::1]/',
    'http://2130706433/',
    'not a url',
  ])('refuses %s', async (url) => {
    await expect(
      createPageFetcher({
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      }).fetchPage(url),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('refuses a host when any resolved address is private (a rebinding-style mix)', async () => {
    await expect(
      testFetcher({ isAddressAllowed: undefined }).fetchPage('http://mixed.test/'),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('reports DNS failures as network errors', async () => {
    await expect(testFetcher().fetchPage('http://does-not-exist.test/')).rejects.toMatchObject({
      code: 'network',
    });
  });
});

describe('isBlockedAddress', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.5.5',
    '172.31.255.255',
    '192.0.0.8',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.7',
    '203.0.113.9',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '64:ff9b::a00:1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    '2001:db8::1',
    '2002:c0a8:101::1',
    '2001::1',
  ])('blocks %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    '93.184.216.34',
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '100.128.0.1',
    '2606:4700:4700::1111',
    '2a00:1450:4001:80e::200e',
    '64:ff9b::808:808',
  ])('allows public %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it('blocks anything that is not an IP address', () => {
    expect(isBlockedAddress('example.com')).toBe(true);
  });
});

describe('htmlToReadableText', () => {
  it('falls back to the page body when Readability finds no article', () => {
    const out = htmlToReadableText(
      '<html><head><title>T</title></head><body><div>Short note.</div><div>Second line.</div></body></html>',
    );
    expect(out.title).toBe('T');
    expect(out.text).toBe('Short note.\nSecond line.');
  });
});

describe('safe downloader (images for scenes)', () => {
  const downloader = (extra: Partial<Parameters<typeof createSafeDownloader>[0]> = {}) =>
    createSafeDownloader({
      lookup: async (host) => {
        if (host === 'site.test') return [{ address: '127.0.0.1', family: 4 }];
        if (host === 'internal.test') return [{ address: '10.0.0.7', family: 4 }];
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      },
      isAddressAllowed: (address) => address === '127.0.0.1',
      ...extra,
    });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]);

  it('downloads an allowed type and reports what it got', async () => {
    routes.set('/img.jpg', () => ({ headers: { 'content-type': 'image/jpeg' }, body: jpeg }));
    const r = await downloader().download(`http://site.test:${port}/img.jpg`, {
      allowedTypes: ['image/jpeg', 'image/png'],
      maxBytes: 1024,
    });
    expect(r).toMatchObject({ url: `http://site.test:${port}/img.jpg`, contentType: 'image/jpeg' });
    expect(Buffer.from(r.bytes)).toEqual(jpeg);
  });

  it('follows a redirect to an allowed host', async () => {
    routes.set('/moved.jpg', () => ({ status: 302, headers: { location: '/img.jpg' } }));
    routes.set('/img.jpg', () => ({ headers: { 'content-type': 'image/jpeg' }, body: jpeg }));
    const r = await downloader().download(`http://site.test:${port}/moved.jpg`, {
      allowedTypes: ['image/jpeg'],
      maxBytes: 1024,
    });
    expect(r.url).toBe(`http://site.test:${port}/img.jpg`);
  });

  it('refuses a type it was not asked for', async () => {
    routes.set('/page', () => ({ body: '<html></html>' }));
    await expect(
      downloader().download(`http://site.test:${port}/page`, {
        allowedTypes: ['image/jpeg'],
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/text\/html/);
  });

  it('refuses a body larger than the cap instead of returning a truncated file', async () => {
    routes.set('/big.jpg', () => ({
      headers: { 'content-type': 'image/jpeg' },
      body: Buffer.alloc(5000, 1),
    }));
    await expect(
      downloader().download(`http://site.test:${port}/big.jpg`, {
        allowedTypes: ['image/jpeg'],
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/too large/i);
  });

  it('refuses private addresses and redirects to them', async () => {
    await expect(
      downloader().download('http://internal.test/x.jpg', {
        allowedTypes: ['image/jpeg'],
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/private or local/);
    routes.set('/sneaky.jpg', () => ({
      status: 302,
      headers: { location: 'http://internal.test/x.jpg' },
    }));
    await expect(
      downloader().download(`http://site.test:${port}/sneaky.jpg`, {
        allowedTypes: ['image/jpeg'],
        maxBytes: 1024,
      }),
    ).rejects.toThrow(/private or local/);
  });

  it('sends no credentials or cookies', async () => {
    routes.set('/img.jpg', () => ({ headers: { 'content-type': 'image/jpeg' }, body: jpeg }));
    seen.length = 0;
    await downloader().download(`http://site.test:${port}/img.jpg`, {
      allowedTypes: ['image/jpeg'],
      maxBytes: 1024,
    });
    expect(seen[0]!.headers.authorization).toBeUndefined();
    expect(seen[0]!.headers.cookie).toBeUndefined();
  });
});
