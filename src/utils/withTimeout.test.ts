import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTimeout } from './withTimeout';

afterEach(() => {
  vi.useRealTimers();
});

describe('等待上限', () => {
  it('按时完成时原样返回结果', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 1000, '超时')).resolves.toBe('ok');
  });

  it('原本就失败时把原始错误透出去，不替换成超时', async () => {
    const cause = new Error('连接被拒绝');
    await expect(withTimeout(Promise.reject(cause), 1000, '超时')).rejects.toBe(cause);
  });

  it('超过上限仍未完成时以超时失败', async () => {
    vi.useFakeTimers();
    const pending = new Promise(() => {});
    const raced = withTimeout(pending, 1000, '连接超时');

    const assertion = expect(raced).rejects.toThrow('连接超时');
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('完成后不再触发超时，也不留下计时器', async () => {
    vi.useFakeTimers();
    const raced = withTimeout(Promise.resolve('ok'), 1000, '超时');
    await expect(raced).resolves.toBe('ok');

    expect(vi.getTimerCount()).toBe(0);
  });

  it('失败后同样清掉计时器', async () => {
    vi.useFakeTimers();
    const raced = withTimeout(Promise.reject(new Error('boom')), 1000, '超时');
    await expect(raced).rejects.toThrow('boom');

    expect(vi.getTimerCount()).toBe(0);
  });
});
