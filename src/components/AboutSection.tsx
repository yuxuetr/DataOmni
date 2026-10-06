import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useLanguageStore } from '../stores/languageStore';
import { describeError } from '../utils/describeError';
import { diagnosticsReport, loadDiagnostics, type Diagnostics } from '../utils/diagnostics';

const BUTTON_CLASS =
  'rounded-control border border-line-strong bg-surface px-2.5 py-1 text-sm text-fg hover:bg-surface-hover disabled:opacity-50';

/**
 * 设置的最后一节：版本、报缺陷时要带的诊断信息、日志文件在哪。
 *
 * 打包版没有开发者工具，用户能带回来的只有这两样：一段诊断信息和一份日志文件
 */
export function AboutSection() {
  const t = useLanguageStore((state) => state.t);
  const language = useLanguageStore((state) => state.resolved);
  const [info, setInfo] = useState<Diagnostics | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadDiagnostics()
      .then((value) => !cancelled && setInfo(value))
      .catch((caught) => !cancelled && setError(describeError(caught)));
    return () => {
      cancelled = true;
    };
  }, []);

  const copy = async () => {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(diagnosticsReport(info, language));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (cause) {
      // 剪贴板可能被拒；静默失败会让人以为复制成功了
      setError(describeError(cause, t('common.copyFailed')));
    }
  };

  const reveal = () => {
    setError(null);
    invoke('reveal_log_file').catch((caught) => setError(describeError(caught)));
  };

  return (
    <div className="border-t border-line px-5 py-4">
      <h3 className="text-sm font-medium text-fg">{t('settings.about.title')}</h3>
      <p className="mt-1 text-xs leading-relaxed text-fg-muted">{t('settings.about.description')}</p>
      <p className="mt-3 px-2 text-sm text-fg">
        {info ? `DataOmni ${info.app_version}` : 'DataOmni'}
      </p>
      {info?.log_file && (
        <p className="mt-1 select-text break-all px-2 font-mono text-xs text-fg-subtle">{info.log_file}</p>
      )}
      <div className="mt-3 flex flex-wrap gap-2 px-2">
        <button type="button" onClick={() => void copy()} disabled={!info} className={BUTTON_CLASS}>
          {copied ? t('settings.about.copied') : t('settings.about.copyDiagnostics')}
        </button>
        <button type="button" onClick={reveal} className={BUTTON_CLASS}>
          {t('settings.about.revealLog')}
        </button>
      </div>
      {error && <p className="mt-2 px-2 text-xs text-danger">{error}</p>}
    </div>
  );
}
