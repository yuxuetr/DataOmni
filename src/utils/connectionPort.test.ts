import { describe, expect, it } from 'vitest';
import { MAX_PORT, MIN_PORT, isUsablePort } from './connectionPort';

describe('connectionPort', () => {
  it('端口的上限是 65535，不是 32767', () => {
    // 这一条是为了挡住一个已经被推翻的说法再长回来。它曾经写在
    // connectionStore 与 queryStore 共四处，把 `-p 43306:3306` 这类映射
    // 直接判死，并建议用户去架 SSH 转发
    expect(isUsablePort(43306)).toBe(true);
    expect(isUsablePort(33306)).toBe(true);
    expect(isUsablePort(MAX_PORT)).toBe(true);
    expect(isUsablePort(MAX_PORT + 1)).toBe(false);
  });

  it('下限是 1，0 与负数都不是端口', () => {
    expect(isUsablePort(MIN_PORT)).toBe(true);
    expect(isUsablePort(0)).toBe(false);
    expect(isUsablePort(-1)).toBe(false);
  });

  it('小数与 NaN 不是端口', () => {
    // 端口来自 <input type="number">，空输入与半个数字都会走到这里
    expect(isUsablePort(3306.5)).toBe(false);
    expect(isUsablePort(Number.NaN)).toBe(false);
  });
});
