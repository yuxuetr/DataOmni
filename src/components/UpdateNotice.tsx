import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { useLanguageStore } from '../stores/languageStore';
import {
  loadUpdateCheck,
  noticeVersion,
  saveUpdateCheck,
  shouldCheckNow
} from '../utils/updateCheck';

/**
 * 标签栏下面那一条「有新版本」。启动时跑一次：到了该问的时候去问 GitHub，
 * 问到的版本比自己新、用户又没关掉过这一版，就提示。没问成只进日志，不打扰
 */
export function UpdateNotice() {
  const t = useLanguageStore((state) => state.t);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let state = loadUpdateCheck();
      const current = await getVersion();
      if (shouldCheckNow(state, Date.now())) {
        let latestVersion = state.latestVersion;
        try {
          latestVersion = await invoke<string>('latest_release');
        } catch (error) {
          console.warn('update check failed', error);
        }
        state = { ...loadUpdateCheck(), lastCheckedAt: Date.now(), latestVersion };
        saveUpdateCheck(state);
      }
      if (!cancelled) {
        setVersion(noticeVersion(state, current));
      }
    })().catch((error: unknown) => console.warn('update check failed', error));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!version) {
    return null;
  }

  const dismiss = () => {
    saveUpdateCheck({ ...loadUpdateCheck(), dismissedVersion: version });
    setVersion(null);
  };

  return (
    <div className="flex items-center gap-3 border-b border-line bg-accent-soft px-3 py-1.5 text-xs text-fg">
      <span className="min-w-0 flex-1">{t('update.available', { version })}</span>
      <button
        type="button"
        onClick={() => {
          invoke('open_release_page', { version }).catch((error: unknown) => console.warn('open release page failed', error));
        }}
        className="shrink-0 font-medium text-accent hover:underline"
      >
        {t('update.view')}
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('common.close')}
        className="shrink-0 text-fg-subtle hover:text-fg"
      >
        ✕
      </button>
    </div>
  );
}
