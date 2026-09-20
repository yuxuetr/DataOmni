import { en } from './en';
import { zh, type TranslationKey, type Translations } from './zh';
import type { ResolvedLanguage } from './language';

export type { TranslationKey, Translations };

export const CATALOGS: Record<ResolvedLanguage, Translations> = { zh, en };

export type TranslationParams = Record<string, string | number>;

/**
 * 取一条文案并替换 `{name}` 形式的占位符。
 *
 * 缺参数时**保留占位符原样**而不是替换成空字符串：界面上留着 `{count}`
 * 一眼就能看出是 bug，而一个消失的数字看上去只是文案写得含糊。
 */
export function translate(
  language: ResolvedLanguage,
  key: TranslationKey,
  params?: TranslationParams
): string {
  const template = CATALOGS[language][key];

  if (!params) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in params ? String(params[name]) : placeholder
  );
}
