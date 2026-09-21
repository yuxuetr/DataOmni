import { useState } from 'react';
import { AlertCircle, ClipboardCopy, Crosshair } from 'lucide-react';
import type { QueryExecutionError } from '../contracts/queryExecution';
import { useLanguageStore } from '../stores/languageStore';
import { formatQueryErrorReport, locateQueryError } from '../utils/queryError';

interface QueryErrorPanelProps {
  /** 已经翻译过的那句话；超时与取消用的是我们自己的文案 */
  message: string;
  /** 数据库给的结构。超时与取消没有——它们不是数据库说的 */
  details?: QueryExecutionError;
  /** 出错的那条语句 */
  sql: string;
  /** 这条语句在整份文档里的起始偏移，用来把相对位置换算成可跳转的位置 */
  statementOffset?: number;
  onJumpToError?: (offset: number) => void;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      {/* 够宽放下最长的那个标签（英文 Constraint）：w-12 会让它压到值上面去 */}
      <span className="w-20 shrink-0 text-xs text-danger/70">{label}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-xs text-danger select-text">
        {value}
      </span>
    </div>
  );
}

/**
 * 查询失败时数据库说的全部内容。
 *
 * 以前这里只有一句 message。数据库给的其余信息在后端就被 `to_string()` 丢掉了，
 * 于是「唯一约束冲突」不说撞的是哪个值，「syntax error near "form"」不说
 * 三百个字符里的哪个 `form`。
 */
export function QueryErrorPanel({
  message,
  details,
  sql,
  statementOffset = 0,
  onJumpToError
}: QueryErrorPanelProps) {
  const t = useLanguageStore((state) => state.t);
  const [copied, setCopied] = useState(false);

  const location = details?.position
    ? locateQueryError(sql, details.position, statementOffset)
    : null;

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(
        formatQueryErrorReport(details ?? { message }, sql, {
          message: t('queryError.message'),
          code: t('queryError.code'),
          position: t('queryError.position'),
          detail: t('queryError.detail'),
          hint: t('queryError.hint'),
          constraint: t('queryError.constraint'),
          table: t('queryError.table'),
          sql: t('queryError.sql')
        })
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      console.warn('复制错误详情失败:', error);
    }
  };

  return (
    <div className="border-t border-danger-line bg-danger-soft p-3">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 shrink-0 text-danger" size={16} />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="whitespace-pre-wrap break-words text-sm text-danger select-text">
            {message}
          </p>

          {(details?.code || location) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-danger/80">
              {details?.code && (
                <span className="font-mono">
                  {t('queryError.code')} {details.code}
                </span>
              )}
              {location && (
                <span>
                  {t('queryError.positionAt', {
                    line: location.line,
                    column: location.column
                  })}
                </span>
              )}
              {/* 只有拿得到位置时才给跳转：MySQL 与 SQLite 不给字符位置，
                  凭空算一个会精确地指错地方 */}
              {location && onJumpToError && (
                <button
                  type="button"
                  onClick={() => onJumpToError(location.offset)}
                  className="flex items-center gap-1 rounded-control border border-danger-line px-1.5 py-0.5 hover:bg-danger-soft"
                >
                  <Crosshair size={11} />
                  {t('queryError.jump')}
                </button>
              )}
            </div>
          )}

          {details?.detail && <Row label={t('queryError.detail')} value={details.detail} />}
          {details?.hint && <Row label={t('queryError.hint')} value={details.hint} />}
          {details?.constraint && (
            <Row label={t('queryError.constraint')} value={details.constraint} />
          )}
          {details?.table && <Row label={t('queryError.table')} value={details.table} />}
        </div>

        <button
          type="button"
          onClick={copyAll}
          title={t('queryError.copyAll')}
          className="flex shrink-0 items-center gap-1 rounded-control border border-danger-line px-2 py-1 text-xs text-danger hover:bg-danger-soft"
        >
          <ClipboardCopy size={12} />
          {copied ? t('common.copied') : t('common.copy')}
        </button>
      </div>
    </div>
  );
}
