import { create } from 'zustand';
import {
  applyLanguage,
  detectSystemLanguage,
  initializeLanguage,
  resolveLanguage,
  saveLanguagePreference,
  type LanguagePreference,
  type ResolvedLanguage
} from '../i18n/language';
import { translate, type TranslationKey, type TranslationParams } from '../i18n/translate';

interface LanguageState {
  preference: LanguagePreference;
  /** 当前真正生效的语言；preference 为 system 时来自系统 */
  resolved: ResolvedLanguage;
  setPreference: (preference: LanguagePreference) => void;
  /** 放在 state 里而不是模块级导出：语言一变，引用也变，订阅它的组件才会重渲染 */
  t: (key: TranslationKey, params?: TranslationParams) => string;
}

// initializeLanguage 已在 main.tsx 里跑过并写好了 <html lang>；
// 这里只是把同一份偏好读进 store 作为初始值。
const initialPreference = initializeLanguage();
const initialResolved = resolveLanguage(initialPreference, detectSystemLanguage());

export const useLanguageStore = create<LanguageState>((set) => ({
  preference: initialPreference,
  resolved: initialResolved,
  t: (key, params) => translate(initialResolved, key, params),
  setPreference: (preference) => {
    const resolved = resolveLanguage(preference, detectSystemLanguage());
    saveLanguagePreference(preference);
    applyLanguage(resolved);
    set({
      preference,
      resolved,
      // 换一个新函数引用，否则以 `t` 为依赖的 memo 不会失效
      t: (key, params) => translate(resolved, key, params)
    });
  }
}));

/**
 * 给 React 之外的代码用：store、工具函数里的错误文案。
 *
 * 组件里请用 `useLanguageStore(state => state.t)`——那样语言切换会触发重渲染，
 * 而这个函数只在**调用的那一刻**取语言，拿到的字符串不会随语言变化而更新。
 */
export function translateNow(key: TranslationKey, params?: TranslationParams): string {
  return useLanguageStore.getState().t(key, params);
}
