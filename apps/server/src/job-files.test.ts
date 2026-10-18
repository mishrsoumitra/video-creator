import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { safeJoin } from './job-files';

const base = resolve('/data/jobs/job1');

describe('safeJoin: URL paths never escape their folder', () => {
  it.each([
    ['image-1.jpg', join(base, 'image-1.jpg')],
    ['images/scene%201.jpg', join(base, 'images', 'scene 1.jpg')],
    ['a/../b.png', join(base, 'b.png')],
  ])('allows %s', (input, expected) => {
    expect(safeJoin(base, input)).toBe(expected);
  });

  it.each([
    '',
    '.',
    '..',
    '../job2/video.mp4',
    '..%2Fjob2%2Fvideo.mp4',
    '%2e%2e/x',
    'a/../../x',
    '/etc/passwd',
    '%2Fetc%2Fpasswd',
    'a%00b',
    '%E0%A4%A',
  ])('refuses %j', (input) => {
    expect(safeJoin(base, input)).toBeNull();
  });
});
