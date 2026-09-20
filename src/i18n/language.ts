/**
 * 语言偏好的读写。
 *
 * 与主题同构：偏好有 `system` 一档，而「当前生效的语言」是另一个值。
 * 但和主题不同——语言不需要在运行期跟随系统变化：用户改系统语言时
 * 操作系统本来就会要求重启应用，没有必要为此订阅一个永远不触发的事件。
 */
export type LanguagePreference = 'zh' | 'en' | 'system';
export type ResolvedLanguage = 'zh' | 'en';

const STORAGE_KEY = 'dataomni_language';

export const SUPPORTED_LANGUAGES: ResolvedLanguage[] = ['zh', 'en'];

function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === 'zh' || value === 'en' || value === 'system';
}

/** 读不到、读坏、localStorage 不可用时一律回落到跟随系统 */
export function loadLanguagePreference(): LanguagePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isLanguagePreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function saveLanguagePreference(preference: LanguagePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // 存储被禁用时语言仍然生效，只是重启后回到跟随系统
  }
}

/**
 * 把系统语言标签映射到支持的语言。
 *
 * 只看主语言子标签：`zh-Hans-CN`、`zh-TW`、`zh` 都是中文。其余一律英文——
 * 不做「相近语言」的猜测，猜错的代价是整个界面变成用户不认识的文字。
 */
export function resolveSystemLanguage(tags: readonly string[]): ResolvedLanguage {
  for (const tag of tags) {
    const primary = tag.toLowerCase().split('-')[0];
    if (primary === 'zh') {
      return 'zh';
    }
    if (primary === 'en') {
      return 'en';
    }
  }
  return 'en';
}

export function detectSystemLanguage(): ResolvedLanguage {
  if (typeof navigator === 'undefined') {
    return 'en';
  }
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  return resolveSystemLanguage(tags.filter(Boolean));
}

export function resolveLanguage(
  preference: LanguagePreference,
  systemLanguage: ResolvedLanguage
): ResolvedLanguage {
  return preference === 'system' ? systemLanguage : preference;
}

/** 写到 <html lang>：影响字体回退、断行规则和读屏软件的发音 */
export function applyLanguage(language: ResolvedLanguage): void {
  document.documentElement.lang = language === 'zh' ? 'zh-Hans' : 'en';
}

/** 首屏渲染前调用，返回读到的偏好交给 store 作为初始值 */
export function initializeLanguage(): LanguagePreference {
  const preference = loadLanguagePreference();
  applyLanguage(resolveLanguage(preference, detectSystemLanguage()));
  return preference;
}
