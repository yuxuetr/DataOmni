import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AI_SETTINGS, aiConfigured, loadAiSettings, saveAiSettings } from './aiSettings';

describe('aiSettings', () => {
  // 测试环境没有 localStorage，照 gridColumns.test.ts 的做法换一个
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      }
    });
  });

  it('没存过就是默认：关着', () => {
    expect(loadAiSettings()).toEqual(DEFAULT_AI_SETTINGS);
    expect(DEFAULT_AI_SETTINGS.enabled).toBe(false);
  });

  it('存进去读得回来', () => {
    const settings = { enabled: true, protocol: 'anthropic' as const, baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-5' };
    saveAiSettings(settings);
    expect(loadAiSettings()).toEqual(settings);
  });

  it('坏掉的一项回到默认，别的保留', () => {
    localStorage.setItem('dataomni.ai-settings', JSON.stringify({ enabled: 'yes', protocol: 'gemini', model: 'm' }));
    expect(loadAiSettings()).toEqual({ enabled: false, protocol: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'm' });
    localStorage.setItem('dataomni.ai-settings', '{not json');
    expect(loadAiSettings()).toEqual(DEFAULT_AI_SETTINGS);
  });

  it('开着且填了地址与模型才算配好', () => {
    expect(aiConfigured({ ...DEFAULT_AI_SETTINGS, enabled: true, model: 'deepseek-flash' })).toBe(true);
    expect(aiConfigured({ ...DEFAULT_AI_SETTINGS, enabled: true, model: ' ' })).toBe(false);
    expect(aiConfigured({ ...DEFAULT_AI_SETTINGS, model: 'deepseek-flash' })).toBe(false);
  });
});
