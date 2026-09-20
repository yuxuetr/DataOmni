import { Monitor, Moon, Sun } from 'lucide-react';
import { clsx } from 'clsx';
import { useThemeStore } from '../stores/themeStore';
import type { ThemePreference } from '../utils/theme';

const OPTIONS: { value: ThemePreference; label: string; Icon: typeof Sun }[] = [
  { value: 'light', label: '浅色', Icon: Sun },
  { value: 'dark', label: '深色', Icon: Moon },
  { value: 'system', label: '跟随系统', Icon: Monitor }
];

/** 三档分段控件。比下拉少一次点击，且三个状态始终可见。 */
export function ThemeToggle() {
  const preference = useThemeStore((state) => state.preference);
  const setPreference = useThemeStore((state) => state.setPreference);

  return (
    <div
      role="radiogroup"
      aria-label="外观"
      className="flex items-center gap-0.5 rounded-control border border-line bg-surface-sunken p-0.5"
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={preference === value}
          title={label}
          aria-label={label}
          onClick={() => setPreference(value)}
          className={clsx(
            'rounded-control px-2 py-1 transition-colors',
            preference === value
              ? 'bg-surface text-fg shadow-sm'
              : 'text-fg-subtle hover:text-fg-muted'
          )}
        >
          <Icon size={13} />
        </button>
      ))}
    </div>
  );
}
