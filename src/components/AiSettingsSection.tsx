import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useLanguageStore } from '../stores/languageStore';
import { useSettingsStore } from '../stores/settingsStore';
import { DEFAULT_BASE_URLS, aiAvailable, type AiProtocol } from '../utils/aiSettings';
import { describeError } from '../utils/describeError';
import { PLAIN_TEXT_INPUT } from './FormControls';

const INPUT_CLASS =
  'w-64 shrink-0 rounded-control border border-line-strong bg-surface px-2 py-1 text-sm text-fg outline-none focus:border-accent';

/**
 * 设置里的 AI 一节。构建里没编进 AI（`--no-default-features`）时整节不出现——
 * 能看见一个开关却打不开，比没有更让人困惑。
 *
 * Key 只进不出：填了就存进系统钥匙串，界面上只显示「已保存」，不回显。
 */
export function AiSettingsSection() {
  const t = useLanguageStore((state) => state.t);
  const ai = useSettingsStore((state) => state.ai);
  const setAi = useSettingsStore((state) => state.setAi);
  const [available, setAvailable] = useState(false);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void aiAvailable().then((value) => {
      if (cancelled || !value) return;
      setAvailable(true);
      invoke<boolean>('ai_has_key')
        .then((present) => !cancelled && setHasKey(present))
        .catch((caught) => !cancelled && setError(describeError(caught)));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!available) {
    return null;
  }

  const changeProtocol = (protocol: AiProtocol) => {
    // 地址还是另一家的默认值（或空着）时跟着换；自己填过的不动
    const untouched = ai.baseUrl.trim() === '' || Object.values(DEFAULT_BASE_URLS).includes(ai.baseUrl.trim());
    setAi({ protocol, ...(untouched ? { baseUrl: DEFAULT_BASE_URLS[protocol] } : {}) });
  };

  const saveKey = async () => {
    setError(null);
    try {
      await invoke('ai_save_key', { key: keyDraft });
      setHasKey(keyDraft.trim() !== '');
      setKeyDraft('');
    } catch (caught) {
      setError(describeError(caught));
    }
  };

  const row = 'flex items-center justify-between gap-3 rounded-control px-2 py-1.5 hover:bg-surface-hover';

  return (
    <div className="border-t border-line px-5 py-4">
      <h3 className="text-sm font-medium text-fg">{t('settings.ai.title')}</h3>
      <p className="mt-1 text-xs leading-relaxed text-fg-muted">{t('settings.ai.description')}</p>

      <div className="mt-3 space-y-1.5">
        <label className={row}>
          <span className="text-sm text-fg">{t('settings.ai.enabled')}</span>
          <input type="checkbox" checked={ai.enabled} onChange={(event) => setAi({ enabled: event.target.checked })} />
        </label>

        <label className={row}>
          <span className="text-sm text-fg">{t('settings.ai.protocol')}</span>
          <select
            value={ai.protocol}
            onChange={(event) => changeProtocol(event.target.value as AiProtocol)}
            className="shrink-0 rounded-control border border-line-strong bg-surface px-2 py-1 text-sm text-fg"
          >
            <option value="openai">{t('settings.ai.protocol.openai')}</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </label>

        <label className={row}>
          <span className="text-sm text-fg">{t('settings.ai.baseUrl')}</span>
          <input value={ai.baseUrl} onChange={(event) => setAi({ baseUrl: event.target.value })} className={INPUT_CLASS} {...PLAIN_TEXT_INPUT} />
        </label>

        <label className={row}>
          <span className="text-sm text-fg">{t('settings.ai.model')}</span>
          <input
            value={ai.model}
            onChange={(event) => setAi({ model: event.target.value })}
            placeholder={ai.protocol === 'anthropic' ? 'claude-sonnet-5' : 'deepseek-chat'}
            className={INPUT_CLASS}
            {...PLAIN_TEXT_INPUT}
          />
        </label>

        <div className={row}>
          <span className="text-sm text-fg">
            {t('settings.ai.key')}
            <span className="ml-2 text-xs text-fg-subtle">
              {hasKey === null ? '' : hasKey ? t('settings.ai.keySaved') : t('settings.ai.keyMissing')}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <input
              type="password"
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
              placeholder={hasKey ? t('settings.ai.keyReplace') : ''}
              aria-label={t('settings.ai.key')}
              className="w-44 rounded-control border border-line-strong bg-surface px-2 py-1 text-sm text-fg outline-none focus:border-accent"
              {...PLAIN_TEXT_INPUT}
            />
            <button
              type="button"
              onClick={() => void saveKey()}
              disabled={keyDraft.trim() === '' && !hasKey}
              className="rounded-control border border-line-strong px-2 py-1 text-sm text-fg hover:bg-surface-hover disabled:opacity-50"
            >
              {keyDraft.trim() === '' && hasKey ? t('settings.ai.keyDelete') : t('settings.ai.keySave')}
            </button>
          </span>
        </div>
      </div>

      {error && <p className="mt-2 px-2 text-xs text-danger break-words">{error}</p>}
      <p className="mt-2 px-2 text-xs text-fg-subtle">{t('settings.ai.privacy')}</p>
    </div>
  );
}
