/**
 * 需要 DOM：applyLanguage 写 <html lang>，偏好读写用 localStorage。
 *
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useLanguageStore, translateNow } from './languageStore';

beforeEach(() => {
  useLanguageStore.getState().setPreference('zh');
});

describe('languageStore', () => {
  it('切换语言后 t 返回新语言的文案', () => {
    expect(useLanguageStore.getState().t('common.copy')).toBe('复制');
    useLanguageStore.getState().setPreference('en');
    expect(useLanguageStore.getState().t('common.copy')).toBe('Copy');
  });

  it('t 的函数引用随语言变化，否则以它为依赖的 memo 不会失效', () => {
    const before = useLanguageStore.getState().t;
    useLanguageStore.getState().setPreference('en');
    expect(useLanguageStore.getState().t).not.toBe(before);
  });

  it('切换语言会写到 <html lang>', () => {
    useLanguageStore.getState().setPreference('en');
    expect(document.documentElement.lang).toBe('en');
    useLanguageStore.getState().setPreference('zh');
    expect(document.documentElement.lang).toBe('zh-Hans');
  });

  it('偏好被持久化', () => {
    useLanguageStore.getState().setPreference('en');
    expect(localStorage.getItem('dataomni_language')).toBe('en');
  });

  it('translateNow 跟随当前语言——给 React 之外的错误文案用', () => {
    useLanguageStore.getState().setPreference('en');
    expect(translateNow('common.copy')).toBe('Copy');
    useLanguageStore.getState().setPreference('zh');
    expect(translateNow('common.copy')).toBe('复制');
  });

  it('translateNow 也替换占位符', () => {
    expect(translateNow('connection.deleteConfirm', { name: 'T1' })).toContain('T1');
  });
});
