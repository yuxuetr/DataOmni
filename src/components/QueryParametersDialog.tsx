import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { SqlDialect } from '../contracts/queryExecution';
import { PLAIN_TEXT_INPUT } from './FormControls';
import { useLanguageStore } from '../stores/languageStore';
import {
  dialectTypesParameters,
  parameterProblem,
  type ParameterInput
} from '../utils/queryParameters';
import { isImeKeyEvent } from '../utils/shortcuts';

interface QueryParametersDialogProps {
  /** 这次要跑的语句里出现的参数名，按第一次出现的次序 */
  names: string[];
  /** 这个标签上次填的值 */
  initial: Record<string, ParameterInput>;
  dialect: SqlDialect;
  onSubmit: (inputs: Record<string, ParameterInput>) => void;
  onClose: () => void;
}

const EMPTY_INPUT: ParameterInput = { value: '', kind: 'text', isNull: false };

/** 运行带 `:name` 的语句之前填值（rfcs/bind-parameters.md §4.3） */
export function QueryParametersDialog({ names, initial, dialect, onSubmit, onClose }: QueryParametersDialogProps) {
  const t = useLanguageStore((state) => state.t);
  const [inputs, setInputs] = useState<Record<string, ParameterInput>>(() =>
    Object.fromEntries(names.map((name) => [name, initial[name] ?? EMPTY_INPUT]))
  );
  const firstInputRef = useRef<HTMLInputElement>(null);
  const typedByDriver = dialectTypesParameters(dialect);

  useEffect(() => {
    firstInputRef.current?.select();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isImeKeyEvent(event)) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const problems = names.flatMap((name) => {
    const problem = parameterProblem(inputs[name], dialect);
    return problem ? [t(problem === 'not-a-number' ? 'params.notANumber' : 'params.outOfRange', { name })] : [];
  });

  const update = (name: string, change: Partial<ParameterInput>) =>
    setInputs((current) => ({ ...current, [name]: { ...current[name], ...change } }));

  const submit = () => {
    if (problems.length === 0) {
      onSubmit(inputs);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="query-parameters-title"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[560px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 id="query-parameters-title" className="text-base font-medium text-fg">{t('params.title')}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-control p-1 text-fg-muted hover:bg-surface-hover hover:text-fg"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>
        <div className="space-y-3 overflow-y-auto px-5 py-4">
          <p className="text-xs text-fg-subtle">
            {t('params.hint')}
            {typedByDriver && ` ${t('params.typedByDriver')}`}
          </p>
          {names.map((name, index) => {
            const input = inputs[name];
            return (
              <div key={name} className="flex items-center gap-2">
                <label htmlFor={`query-parameter-${index}`} className="w-32 shrink-0 truncate font-mono text-[13px] text-fg" title={`:${name}`}>
                  :{name}
                </label>
                <input
                  id={`query-parameter-${index}`}
                  ref={index === 0 ? firstInputRef : undefined}
                  value={input.isNull ? '' : input.value}
                  disabled={input.isNull}
                  placeholder={input.isNull ? 'NULL' : undefined}
                  onChange={(event) => update(name, { value: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !isImeKeyEvent(event.nativeEvent)) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                  className="min-w-0 flex-1 rounded-control border border-line bg-surface px-2 py-1.5 font-mono text-[13px] text-fg placeholder:text-fg-subtle disabled:opacity-60"
                  {...PLAIN_TEXT_INPUT}
                />
                {!typedByDriver && (
                  <select
                    value={input.kind}
                    disabled={input.isNull}
                    onChange={(event) => update(name, { kind: event.target.value as ParameterInput['kind'] })}
                    aria-label={t('params.kind', { name })}
                    className="rounded-control border border-line bg-surface px-2 py-1.5 text-xs text-fg disabled:opacity-60"
                  >
                    <option value="text">{t('params.text')}</option>
                    <option value="number">{t('params.number')}</option>
                  </select>
                )}
                <label className="flex shrink-0 items-center gap-1 text-xs text-fg-muted">
                  <input
                    type="checkbox"
                    checked={input.isNull}
                    onChange={(event) => update(name, { isNull: event.target.checked })}
                  />
                  {t('params.null')}
                </label>
              </div>
            );
          })}
          {problems.map((problem) => (
            <p key={problem} className="text-xs text-danger">{problem}</p>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line bg-surface-sunken px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={problems.length > 0}
            className="rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:opacity-90 disabled:opacity-50"
          >
            {t('params.run')}
          </button>
        </div>
      </div>
    </div>
  );
}
