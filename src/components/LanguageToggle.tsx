import { Globe } from 'lucide-react';
import { clsx } from 'clsx';
import { useLanguageStore } from '../stores/languageStore';
import type { LanguagePreference } from '../i18n/language';
import type { TranslationKey } from '../i18n/translate';

const OPTIONS: { value: LanguagePreference; labelKey: TranslationKey; short: string }[] = [
  { value: 'zh', labelKey: 'app.language.zh', short: '中' },
  { value: 'en', labelKey: 'app.language.en', short: 'EN' },
  { value: 'system', labelKey: 'app.language.system', short: '' }
];

/** 与外观切换同构的三档分段控件：三个状态始终可见，比下拉少一次点击。 */
export function LanguageToggle() {
  const preference = useLanguageStore((state) => state.preference);
  const setPreference = useLanguageStore((state) => state.setPreference);
  const t = useLanguageStore((state) => state.t);

  return (
    <div
      role="radiogroup"
      aria-label={t('app.language')}
      className="flex items-center gap-0.5 rounded-control border border-line bg-surface-sunken p-0.5"
    >
      {OPTIONS.map(({ value, labelKey, short }) => {
        const label = t(labelKey);
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={preference === value}
            title={label}
            aria-label={label}
            onClick={() => setPreference(value)}
            className={clsx(
              'flex h-[23px] min-w-[26px] items-center justify-center rounded-control px-1.5 text-xs transition-colors',
              preference === value
                ? 'bg-surface text-fg shadow-sm'
                : 'text-fg-subtle hover:text-fg-muted'
            )}
          >
            {/* 「跟随系统」没有对应的文字缩写，用图标；另外两档直接显示语言本身 */}
            {short || <Globe size={13} />}
          </button>
        );
      })}
    </div>
  );
}
