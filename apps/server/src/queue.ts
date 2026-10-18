/** A FIFO task queue with a concurrency limit. Renders use 1; preparations a few. */
export class TaskQueue {
  private readonly waiting: Array<() => Promise<void>> = [];
  private running = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly concurrency: number) {}

  push(task: () => Promise<void>): void {
    this.waiting.push(task);
    this.next();
  }

  get size(): number {
    return this.waiting.length + this.running;
  }

  /** Resolves when nothing is queued or running. */
  idle(): Promise<void> {
    return this.size === 0 ? Promise.resolve() : new Promise((r) => this.idleWaiters.push(r));
  }

  private next(): void {
    while (this.running < this.concurrency && this.waiting.length > 0) {
      const task = this.waiting.shift()!;
      this.running++;
      void task()
        .catch(() => undefined)
        .finally(() => {
          this.running--;
          this.next();
          if (this.size === 0) {
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            for (const w of waiters) w();
          }
        });
    }
  }
}
