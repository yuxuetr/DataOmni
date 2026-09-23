import { useEffect } from 'react';
import { X } from 'lucide-react';
import { ENVIRONMENTS, ENVIRONMENT_NAME_KEYS, environmentBadge } from '../contracts/environment';
import {
  CONFIRMATION_THRESHOLDS,
  type ConfirmationThreshold
} from '../utils/confirmationPolicy';
import { useSettingsStore } from '../stores/settingsStore';
import { GRID_DENSITIES, type GridDensity } from '../utils/gridColumns';
import { useHistoryStore } from '../stores/historyStore';
import {
  RETENTION_DAY_CHOICES,
  RETENTION_ENTRY_CHOICES,
  SLOW_QUERY_MS_CHOICES
} from '../utils/queryHistoryStorage';
import { useLanguageStore } from '../stores/languageStore';
import type { TranslationKey } from '../i18n/translate';

interface SettingsDialogProps {
  onClose: () => void;
}

const THRESHOLD_LABEL_KEYS: Record<ConfirmationThreshold, TranslationKey> = {
  never: 'settings.threshold.never',
  destructive: 'settings.threshold.destructive',
  'bulk-write': 'settings.threshold.bulk-write',
  'scoped-write': 'settings.threshold.scoped-write',
  append: 'settings.threshold.append'
};

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const t = useLanguageStore((state) => state.t);
  const confirmationPolicy = useSettingsStore((state) => state.confirmationPolicy);
  const gridDensity = useSettingsStore((state) => state.gridDensity);
  const setGridDensity = useSettingsStore((state) => state.setGridDensity);
  const setConfirmationThreshold = useSettingsStore((state) => state.setConfirmationThreshold);
  const retention = useHistoryStore((state) => state.retention);
  const setRetention = useHistoryStore((state) => state.setRetention);
  const historyCount = useHistoryStore((state) => state.entries.length);

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
        // 限高并让正文滚动：设置项只会越加越多，撑出屏幕时标题栏连同关闭
        // 按钮会一起被挤出可视区，那时除了 Esc 没有别的出路
        className="flex max-h-[calc(100vh-4rem)] w-[600px] max-w-[calc(100vw-2rem)] flex-col rounded-panel bg-surface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3">
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

        <div className="min-h-0 flex-1 overflow-auto">
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
                      {t(ENVIRONMENT_NAME_KEYS[environment])}
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
                      aria-label={`${t(ENVIRONMENT_NAME_KEYS[environment])} · ${t('settings.confirmation.threshold')}`}
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

        <div className="border-t border-line px-5 py-4">
          <h3 className="text-sm font-medium text-fg">{t('settings.appearance.title')}</h3>
          {/* 行高在表数据网格的列菜单里也能调，但查询结果那张网格没有列菜单，
              没有这里的话它那档就只能跟着别处改 */}
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            {t('settings.density.description')}
          </p>

          <div className="mt-3">
            <label className="flex items-center justify-between gap-3 rounded-control px-2 py-1.5 hover:bg-surface-hover">
              <span className="text-sm text-fg">{t('columns.density')}</span>
              <select
                value={gridDensity}
                onChange={(event) => setGridDensity(event.target.value as GridDensity)}
                className="shrink-0 rounded-control border border-line-strong bg-surface px-2 py-1 text-sm text-fg"
              >
                {GRID_DENSITIES.map((density) => (
                  <option key={density} value={density}>
                    {t(`columns.density.${density}` as TranslationKey)}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="border-t border-line px-5 py-4">
          <h3 className="text-sm font-medium text-fg">{t('settings.history.title')}</h3>
          {/* 调小上限会**立刻**删记录，而且删掉就没了。说在前面，不是等用户
              发现历史短了一截再去猜原因 */}
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            {t('settings.history.description')}
          </p>

          <div className="mt-3 space-y-1.5">
            <label className="flex items-center justify-between gap-3 rounded-control px-2 py-1.5 hover:bg-surface-hover">
              <span className="text-sm text-fg">{t('settings.history.maxAge')}</span>
              <select
                value={retention.maxAgeDays}
                onChange={(event) =>
                  setRetention({ maxAgeDays: Number(event.target.value) })
                }
                className="shrink-0 rounded-control border border-line-strong bg-surface px-2 py-1 text-sm text-fg"
              >
                {RETENTION_DAY_CHOICES.map((days) => (
                  <option key={days} value={days}>
                    {days === 0 ? t('settings.history.unlimited') : t('settings.history.days', { days })}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center justify-between gap-3 rounded-control px-2 py-1.5 hover:bg-surface-hover">
              <span className="text-sm text-fg">{t('settings.history.maxEntries')}</span>
              <select
                value={retention.maxEntries}
                onChange={(event) =>
                  setRetention({ maxEntries: Number(event.target.value) })
                }
                className="shrink-0 rounded-control border border-line-strong bg-surface px-2 py-1 text-sm text-fg"
              >
                {RETENTION_ENTRY_CHOICES.map((count) => (
                  <option key={count} value={count}>
                    {t('settings.history.entries', { count })}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center justify-between gap-3 rounded-control px-2 py-1.5 hover:bg-surface-hover">
              <span className="text-sm text-fg">{t('settings.history.slowQuery')}</span>
              <select
                value={retention.slowQueryMs}
                onChange={(event) => setRetention({ slowQueryMs: Number(event.target.value) })}
                className="shrink-0 rounded-control border border-line-strong bg-surface px-2 py-1 text-sm text-fg"
              >
                {SLOW_QUERY_MS_CHOICES.map((ms) => (
                  <option key={ms} value={ms}>
                    {ms === 0
                      ? t('settings.history.slowQueryOff')
                      : t('settings.history.slowQueryMs', { ms })}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="mt-2 px-2 text-xs text-fg-subtle">
            {t('settings.history.slowQueryNote')}
          </p>

            <p className="mt-2 px-2 text-xs text-fg-subtle">
              {t('settings.history.current', { count: historyCount })}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
