import { useEffect } from 'react';
import { X } from 'lucide-react';
import type { ConnectionEnvironment } from '../contracts';
import { environmentBadge } from '../contracts/environment';
import {
  CONFIRMATION_THRESHOLDS,
  type ConfirmationThreshold
} from '../utils/confirmationPolicy';
import { useSettingsStore } from '../stores/settingsStore';
import { useLanguageStore } from '../stores/languageStore';
import type { TranslationKey } from '../i18n/translate';

interface SettingsDialogProps {
  onClose: () => void;
}

const ENVIRONMENTS: readonly ConnectionEnvironment[] = [
  'development',
  'testing',
  'staging',
  'production'
];

const THRESHOLD_LABEL_KEYS: Record<ConfirmationThreshold, TranslationKey> = {
  never: 'settings.threshold.never',
  destructive: 'settings.threshold.destructive',
  'bulk-write': 'settings.threshold.bulk-write',
  'scoped-write': 'settings.threshold.scoped-write',
  append: 'settings.threshold.append'
};

/**
 * 环境全名，不是徽标上那个短标签。
 *
 * 借用 `environment.staging` 会让这一行显示成「预发 [预发]」——名字和徽标
 * 是同一个词，重复一遍不提供任何信息。
 */
const ENVIRONMENT_LABEL_KEYS: Record<ConnectionEnvironment, TranslationKey> = {
  development: 'environment.name.development',
  testing: 'environment.name.testing',
  staging: 'environment.name.staging',
  production: 'environment.name.production'
};

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const t = useLanguageStore((state) => state.t);
  const confirmationPolicy = useSettingsStore((state) => state.confirmationPolicy);
  const setConfirmationThreshold = useSettingsStore((state) => state.setConfirmationThreshold);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      onClick={onClose}
    >
      <div
        className="w-[600px] max-w-[calc(100vw-2rem)] rounded-panel bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 id="settings-title" className="text-base font-medium text-fg">
            {t('settings.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-control p-1 text-fg-subtle hover:bg-surface-hover hover:text-fg"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4">
          <h3 className="text-sm font-medium text-fg">{t('settings.confirmation.title')}</h3>
          {/* 把「确认不等于权限控制」写在这里，而不是只写在提交说明里：
              会来调这个设置的人，正是最可能把它当成权限开关的人 */}
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            {t('settings.confirmation.description')}
          </p>

          <div className="mt-3 space-y-1.5">
            {ENVIRONMENTS.map((environment) => {
              const badge = environmentBadge(environment);
              return (
                <label
                  key={environment}
                  className="flex items-center justify-between gap-3 rounded-control px-2 py-1.5 hover:bg-surface-hover"
                >
                  <span className="flex min-w-0 items-center gap-2 text-sm text-fg">
                    {t(ENVIRONMENT_LABEL_KEYS[environment])}
                    {badge && (
                      <span
                        className={
                          badge.tone === 'danger'
                            ? 'shrink-0 rounded-control border border-danger-line bg-danger-soft px-1.5 py-0.5 text-[11px] font-medium text-danger'
                            : 'shrink-0 rounded-control border border-warning-line bg-warning-soft px-1.5 py-0.5 text-[11px] font-medium text-warning'
                        }
                      >
                        {t(badge.labelKey)}
                      </span>
                    )}
                  </span>
                  <select
                    value={confirmationPolicy[environment]}
                    onChange={(event) =>
                      setConfirmationThreshold(
                        environment,
                        event.target.value as ConfirmationThreshold
                      )
                    }
                    aria-label={`${t(ENVIRONMENT_LABEL_KEYS[environment])} · ${t('settings.confirmation.threshold')}`}
                    className="shrink-0 rounded-control border border-line-strong bg-surface px-2 py-1 text-sm text-fg"
                  >
                    {CONFIRMATION_THRESHOLDS.map((threshold) => (
                      <option key={threshold} value={threshold}>
                        {t(THRESHOLD_LABEL_KEYS[threshold])}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
