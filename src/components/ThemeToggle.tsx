import { Monitor, Moon, Sun } from "lucide-react";
import { clsx } from "clsx";
import { useThemeStore } from "../stores/themeStore";
import { useLanguageStore } from "../stores/languageStore";
import type { ThemePreference } from "../utils/theme";
import type { TranslationKey } from "../i18n/translate";

const OPTIONS: {
  value: ThemePreference;
  labelKey: TranslationKey;
  Icon: typeof Sun;
}[] = [
  { value: "light", labelKey: "app.theme.light", Icon: Sun },
  { value: "dark", labelKey: "app.theme.dark", Icon: Moon },
  { value: "system", labelKey: "app.theme.system", Icon: Monitor },
];

/** 三档分段控件。比下拉少一次点击，且三个状态始终可见。 */
export function ThemeToggle() {
  const preference = useThemeStore((state) => state.preference);
  const setPreference = useThemeStore((state) => state.setPreference);
  const t = useLanguageStore((state) => state.t);

  return (
    <div
      role="radiogroup"
      aria-label={t("app.appearance")}
      className="flex items-center gap-0.5 rounded-control border border-line bg-surface-sunken p-0.5"
    >
      {OPTIONS.map(({ value, labelKey, Icon }) => {
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
              "rounded-control px-2 py-1 transition-colors",
              preference === value
                ? "bg-surface text-fg shadow-sm"
                : "text-fg-subtle hover:text-fg-muted",
            )}
          >
            <Icon size={13} />
          </button>
        );
      })}
    </div>
  );
}
