/**
 * 需要 DOM：错误文案走 i18n，而 store 在加载时会写 <html lang>。
 *
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { requireDatabase } from './requireDatabase';
import { useLanguageStore } from '../stores/languageStore';

beforeEach(() => {
  useLanguageStore.getState().setPreference('zh');
});

describe('requireDatabase', () => {
  it('有句柄时原样返回', () => {
    const handle = { select: () => Promise.resolve([]) } as never;
    expect(requireDatabase(handle)).toBe(handle);
  });

  it('没有句柄时抛出看得懂的文案，而不是 TypeError', () => {
    // `database!.select(...)` 抛的是「Cannot read properties of null」，
    // 用户只看到一句「null 类型错误」，既不知道发生了什么也不知道该做什么
    expect(() => requireDatabase(null)).toThrow('数据库未连接');
  });

  it('错误文案跟着界面语言走', () => {
    useLanguageStore.getState().setPreference('en');
    expect(() => requireDatabase(null)).toThrow('Not connected');
  });
});
