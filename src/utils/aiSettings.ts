import { invoke } from '@tauri-apps/api/core';

/** 两种协议覆盖所有模型服务：国内各家与本地 Ollama 都给 OpenAI 兼容接口 */
export type AiProtocol = 'anthropic' | 'openai';

export interface AiSettings {
  /** 默认关：AI 是附加功能，开了才有设计入口，也才会有请求发出去 */
  enabled: boolean;
  protocol: AiProtocol;
  /** Anthropic 写到域名；OpenAI 兼容写到 `/chat/completions` 之前那一段 */
  baseUrl: string;
  model: string;
}

export const DEFAULT_BASE_URLS: Record<AiProtocol, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1'
};

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  protocol: 'openai',
  baseUrl: DEFAULT_BASE_URLS.openai,
  model: ''
};

const STORAGE_KEY = 'dataomni.ai-settings';

/** 存的是 JSON，读回来逐项核对；坏掉的一项回到默认，不让整份设置作废 */
export function loadAiSettings(): AiSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<AiSettings> | null;
    if (!raw || typeof raw !== 'object') {
      return DEFAULT_AI_SETTINGS;
    }
    const protocol = raw.protocol === 'anthropic' || raw.protocol === 'openai' ? raw.protocol : DEFAULT_AI_SETTINGS.protocol;
    return {
      enabled: raw.enabled === true,
      protocol,
      baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : DEFAULT_BASE_URLS[protocol],
      model: typeof raw.model === 'string' ? raw.model : ''
    };
  } catch {
    return DEFAULT_AI_SETTINGS;
  }
}

export function saveAiSettings(settings: AiSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 存储不可用时这一轮仍然生效，只是重启后回到默认
  }
}

/** 能不能发请求：开着、填了地址和模型。Key 在钥匙串里，另问后端 */
export function aiConfigured(settings: AiSettings): boolean {
  return settings.enabled && settings.baseUrl.trim() !== '' && settings.model.trim() !== '';
}

let availability: Promise<boolean> | null = null;

/**
 * 这个构建有没有编进 AI（Cargo feature `ai`）。进程内只问一次：构建期定下的事，运行中不会变。
 * 前端没有自己的构建开关，全听后端的，不会两边对不上
 */
export function aiAvailable(): Promise<boolean> {
  availability ??= invoke<boolean>('ai_available').catch(() => false);
  return availability;
}
