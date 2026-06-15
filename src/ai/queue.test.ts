import { describe, it, expect } from 'vitest';
import { AiInferenceQueue, type AiJob } from './queue';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('AiInferenceQueue', () => {
  it('processes jobs in enqueue order (serial, FIFO)', async () => {
    const queue = new AiInferenceQueue();
    const order: number[] = [];

    const makeJob = (i: number): AiJob => ({
      run: async () => {
        await delay(5);
        order.push(i);
      },
    });

    queue.enqueue(makeJob(0));
    queue.enqueue(makeJob(1));
    queue.enqueue(makeJob(2));

    await queue.drain();

    expect(order).toEqual([0, 1, 2]);
  });

  it('never has two jobs running concurrently', async () => {
    const queue = new AiInferenceQueue();
    let active = 0;
    let maxActive = 0;

    const makeJob = (): AiJob => ({
      run: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(5);
        active -= 1;
      },
    });

    queue.enqueue(makeJob());
    queue.enqueue(makeJob());
    queue.enqueue(makeJob());

    await queue.drain();

    expect(maxActive).toBe(1);
  });

  it('drain() resolves only after all enqueued jobs have completed', async () => {
    const queue = new AiInferenceQueue();
    const completed: boolean[] = [false, false, false];

    const makeJob = (i: number): AiJob => ({
      run: async () => {
        await delay(5);
        completed[i] = true;
      },
    });

    queue.enqueue(makeJob(0));
    queue.enqueue(makeJob(1));
    queue.enqueue(makeJob(2));

    await queue.drain();

    expect(completed).toEqual([true, true, true]);
  });

  it('a rejecting job does not stop subsequent jobs (error isolation)', async () => {
    const queue = new AiInferenceQueue();
    const order: string[] = [];

    queue.enqueue({
      run: async () => {
        order.push('job1-start');
        await delay(5);
        order.push('job1-end');
      },
    });
    queue.enqueue({
      run: async () => {
        order.push('job2-start');
        throw new Error('job2 failed');
      },
    });
    queue.enqueue({
      run: async () => {
        order.push('job3-start');
        await delay(5);
        order.push('job3-end');
      },
    });

    await expect(queue.drain()).resolves.toBeUndefined();

    expect(order).toEqual(['job1-start', 'job1-end', 'job2-start', 'job3-start', 'job3-end']);
  });

  it('a new queue reports size === 0', () => {
    const queue = new AiInferenceQueue();
    expect(queue.size).toBe(0);
  });

  it('size reflects the count still queued after enqueuing never-resolving jobs', () => {
    const queue = new AiInferenceQueue();

    const neverResolves = (): AiJob => ({
      run: () => new Promise<void>(() => {}),
    });

    queue.enqueue(neverResolves());
    queue.enqueue(neverResolves());
    queue.enqueue(neverResolves());

    // First job is shifted into "processing" immediately; the other two remain queued.
    expect(queue.size).toBe(2);
  });

  it('reading size does not consume jobs (read-only, no shift/pop)', () => {
    const queue = new AiInferenceQueue();

    const neverResolves = (): AiJob => ({
      run: () => new Promise<void>(() => {}),
    });

    queue.enqueue(neverResolves());
    queue.enqueue(neverResolves());

    const first = queue.size;
    const second = queue.size;

    expect(first).toBe(second);
    expect(first).toBe(1);
  });
});
