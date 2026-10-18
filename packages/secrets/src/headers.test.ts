import { describe, expect, it } from 'vitest';
import { SENSITIVE_HEADER_NAMES, redactHeaders, redactUrl } from './index';

describe('SENSITIVE_HEADER_NAMES', () => {
  it('covers every header a provider key travels in', () => {
    for (const name of [
      'authorization',
      'x-api-key',
      'xi-api-key',
      'x-goog-api-key',
      'ocp-apim-subscription-key',
      'x-subscription-token',
      'api-key',
      'cookie',
      'set-cookie',
    ]) {
      expect(SENSITIVE_HEADER_NAMES).toContain(name);
    }
  });
});

describe('redactHeaders', () => {
  it('redacts sensitive headers case-insensitively and keeps the rest', () => {
    expect(
      redactHeaders({
        Authorization: 'Bearer sk-123',
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': 'AIza123',
      }),
    ).toEqual({
      Authorization: '[REDACTED]',
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': '[REDACTED]',
    });
  });

  it('accepts a Headers instance', () => {
    const headers = new Headers({ 'xi-api-key': 'eleven', accept: 'audio/mpeg' });
    expect(redactHeaders(headers)).toEqual({ 'xi-api-key': '[REDACTED]', accept: 'audio/mpeg' });
  });

  it('accepts header tuples and multi-value headers', () => {
    expect(
      redactHeaders([
        ['x-api-key', 'k'],
        ['user-agent', 'vc'],
      ]),
    ).toEqual({ 'x-api-key': '[REDACTED]', 'user-agent': 'vc' });
    expect(redactHeaders({ 'set-cookie': ['a=1', 'b=2'], via: ['x', 'y'] })).toEqual({
      'set-cookie': ['[REDACTED]', '[REDACTED]'],
      via: ['x', 'y'],
    });
  });

  it('drops undefined values', () => {
    expect(redactHeaders({ host: 'h', 'x-empty': undefined })).toEqual({ host: 'h' });
  });
});

describe('redactUrl', () => {
  it('masks key-like query parameters and leaves the rest untouched', () => {
    expect(
      redactUrl('https://serpapi.com/search.json?engine=google&q=moon%20landing&api_key=SECRET123'),
    ).toBe('https://serpapi.com/search.json?engine=google&q=moon%20landing&api_key=[REDACTED]');
  });

  it.each(['key', 'token', 'access_token', 'API_KEY', 'apikey'])('masks %s', (name) => {
    expect(redactUrl(`https://h.example/p?${name}=abc&x=1`)).toBe(
      `https://h.example/p?${name}=[REDACTED]&x=1`,
    );
  });

  it('does not touch parameters that merely end in "key"', () => {
    expect(redactUrl('https://h.example/p?monkey=1&keyboard=2')).toBe(
      'https://h.example/p?monkey=1&keyboard=2',
    );
  });

  it('masks a password in the userinfo part', () => {
    expect(redactUrl('https://user:hunter2@h.example/path')).toBe(
      'https://user:[REDACTED]@h.example/path',
    );
  });

  it('keeps fragments', () => {
    expect(redactUrl('https://h.example/p?token=abc#frag')).toBe(
      'https://h.example/p?token=[REDACTED]#frag',
    );
  });

  it('falls back to pattern matching for strings that are not URLs', () => {
    expect(redactUrl('GET /search?api_key=abc&q=1 failed')).toBe(
      'GET /search?api_key=[REDACTED]&q=1 failed',
    );
  });
});
