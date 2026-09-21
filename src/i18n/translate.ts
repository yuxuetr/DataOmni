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
 *
 * `count` 为 1 且存在 `<key>.one` 时改用它。英文的「1 rows」「1 statements」
 * 一眼就露怯，而让每个调用点自己去三元判断，意味着每加一处带数量的文案都要
 * 重新想一遍——想漏了不会报错，只会在界面上留下一句别扭的英文。中文没有单复数，
 * `.one` 与原键同文，代价只有目录里多一行。
 */
export function translate(
  language: ResolvedLanguage,
  key: TranslationKey,
  params?: TranslationParams
): string {
  const catalog = CATALOGS[language];
  const singular = `${key}.one` as TranslationKey;
  const template =
    params?.count === 1 && singular in catalog ? catalog[singular] : catalog[key];

  if (!params) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in params ? String(params[name]) : placeholder
  );
}
