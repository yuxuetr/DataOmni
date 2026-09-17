import { describe, expect, it, vi } from 'vitest';
import { executeSequentially } from './queryExecutionPolicy';

describe('executeSequentially', () => {
  it('executes statements in document order', async () => {
    const order: number[] = [];

    const summary = await executeSequentially([1, 2, 3], async (item) => {
      order.push(item);
      return true;
    });

    expect(order).toEqual([1, 2, 3]);
    expect(summary).toEqual({
      attempted: 3,
      succeeded: 3,
      stoppedAtIndex: null
    });
  });

  it('stops after the first failure, timeout, or cancellation', async () => {
    const execute = vi.fn(async (item: number) => item !== 2);

    const summary = await executeSequentially([1, 2, 3], execute);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({
      attempted: 2,
      succeeded: 1,
      stoppedAtIndex: 1
    });
  });
});
