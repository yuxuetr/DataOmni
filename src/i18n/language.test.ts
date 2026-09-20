/**
 * 这个文件需要 DOM：applyLanguage 写 <html lang>，偏好读写用 localStorage。
 * 只给这一个文件换环境，其余纯逻辑测试仍跑在更快的 node 环境里。
 *
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyLanguage,
  loadLanguagePreference,
  resolveLanguage,
  resolveSystemLanguage,
  saveLanguagePreference
} from './language';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('loadLanguagePreference', () => {
  it('读得到就用读到的', () => {
    localStorage.setItem('dataomni_language', 'en');
    expect(loadLanguagePreference()).toBe('en');
  });

  it('存了非法值时回落到跟随系统，而不是崩溃或用它当语言', () => {
    localStorage.setItem('dataomni_language', 'klingon');
    expect(loadLanguagePreference()).toBe('system');
  });

  it('localStorage 抛错时回落到跟随系统', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(loadLanguagePreference()).toBe('system');
  });
});

describe('saveLanguagePreference', () => {
  it('写入后能读回来', () => {
    saveLanguagePreference('zh');
    expect(localStorage.getItem('dataomni_language')).toBe('zh');
  });

  it('localStorage 抛错时不向外抛——语言已经切了，只是记不住', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    expect(() => saveLanguagePreference('en')).not.toThrow();
  });
});

describe('resolveSystemLanguage', () => {
  it('只看主语言子标签：zh-Hans-CN / zh-TW / zh 都是中文', () => {
    expect(resolveSystemLanguage(['zh-Hans-CN'])).toBe('zh');
    expect(resolveSystemLanguage(['zh-TW'])).toBe('zh');
    expect(resolveSystemLanguage(['ZH'])).toBe('zh');
  });

  it('按优先级取第一个支持的语言，而不是第一个标签', () => {
    expect(resolveSystemLanguage(['fr-FR', 'zh-CN', 'en-US'])).toBe('zh');
  });

  it('一个都不支持时用英文，不猜相近语言', () => {
    // 猜错的代价是整个界面变成用户不认识的文字
    expect(resolveSystemLanguage(['fr-FR', 'de-DE'])).toBe('en');
  });

  it('空列表时用英文', () => {
    expect(resolveSystemLanguage([])).toBe('en');
  });
});

describe('resolveLanguage', () => {
  it('明确指定时不理系统', () => {
    expect(resolveLanguage('en', 'zh')).toBe('en');
    expect(resolveLanguage('zh', 'en')).toBe('zh');
  });

  it('跟随系统时用系统语言', () => {
    expect(resolveLanguage('system', 'zh')).toBe('zh');
    expect(resolveLanguage('system', 'en')).toBe('en');
  });
});

describe('applyLanguage', () => {
  it('中文写成 zh-Hans，不是 zh——字体回退与断行规则按这个走', () => {
    applyLanguage('zh');
    expect(document.documentElement.lang).toBe('zh-Hans');
    applyLanguage('en');
    expect(document.documentElement.lang).toBe('en');
  });
});
