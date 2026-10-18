import { describe, expect, it } from 'vitest';
import { TaskQueue } from './queue';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('TaskQueue', () => {
  it('is idle straight away when empty', async () => {
    await expect(new TaskQueue(1).idle()).resolves.toBeUndefined();
  });

  it('runs tasks in order, never more than the concurrency at once', async () => {
    const queue = new TaskQueue(2);
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    for (let i = 0; i < 6; i++) {
      queue.push(async () => {
        order.push(i);
        running++;
        peak = Math.max(peak, running);
        await tick();
        running--;
      });
    }
    expect(queue.size).toBe(6);
    await queue.idle();
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    expect(queue.size).toBe(0);
  });

  it('keeps going after a task fails', async () => {
    const queue = new TaskQueue(1);
    const done: string[] = [];
    queue.push(async () => {
      throw new Error('boom');
    });
    queue.push(async () => {
      done.push('after');
    });
    await queue.idle();
    expect(done).toEqual(['after']);
  });

  it('resolves every waiter once the last task finishes', async () => {
    const queue = new TaskQueue(1);
    let release!: () => void;
    queue.push(() => new Promise<void>((r) => (release = r)));
    const waiters = [queue.idle(), queue.idle()];
    await tick();
    release();
    await expect(Promise.all(waiters)).resolves.toEqual([undefined, undefined]);
  });
});
