import { clsx } from 'clsx';
import type { ConnectionEnvironment } from '../contracts';
import { environmentBadge } from '../contracts/environment';
import { useLanguageStore } from '../stores/languageStore';

interface EnvironmentBadgeProps {
  environment: ConnectionEnvironment;
  /** 紧凑场景（标签页）用更小的字号 */
  compact?: boolean;
}

export function EnvironmentBadgeTag({ environment, compact = false }: EnvironmentBadgeProps) {
  const t = useLanguageStore((state) => state.t);
  const badge = environmentBadge(environment);
  if (!badge) {
    return null;
  }

  return (
    <span
      title={t(badge.descriptionKey)}
      className={clsx(
        'shrink-0 rounded-control border font-medium',
        compact ? 'px-1 text-[10px] leading-tight' : 'px-1.5 py-0.5 text-[11px]',
        badge.tone === 'danger'
          ? 'border-danger-line bg-danger-soft text-danger'
          : 'border-warning-line bg-warning-soft text-warning'
      )}
    >
      {t(badge.labelKey)}
    </span>
  );
}
