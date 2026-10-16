import { useMemo, useState } from 'react';
import { ArrowLeftRight, Loader2, Plus, Spline, Trash2, X } from 'lucide-react';
import { useLanguageStore } from '../stores/languageStore';
import { PLAIN_TEXT_INPUT } from './FormControls';
import {
  draftOf,
  entityWrite,
  relationshipCreate,
  type DraftProblem,
  type EditableEntity,
  type EntityDraft,
  type RelationshipEnds
} from '../utils/cypherEdit';
import { cypherName, formatCypherValue, type CypherNodeValue } from '../utils/cypherValue';
import type { TranslationKey, TranslationParams } from '../i18n/translate';
import { HighlightedCode } from './HighlightedCode';
import { isImeKeyEvent } from '../utils/shortcuts';

interface CypherEntityEditorProps {
  /** `null` 是建一个新节点，或者给了 `relationship` 时建一条关系 */
  entity: EditableEntity | null;
  /** 建关系：两头已经选好（`entity` 为 `null`） */
  relationship?: RelationshipEnds;
  /** 看着的是节点时才给：以它为起点建关系，接着去结果里点终点 */
  onLink?: () => void;
  busy: boolean;
  error: string | null;
  onSave: (statement: string, labelsChanged: boolean) => void;
  /** 有了比打开时更新的样子（保存被拒后读回来的）才给：「还原」还原到它，而不是打开时那份 */
  onRevert?: () => void;
  onDelete: () => void;
  onClose: () => void;
}


/**
 * 结果里点中的节点或关系：改属性、加摘标签、删。也用来建节点。
 *
 * 只管编辑框里的样子；写成哪条语句是 `entityWrite` 的事，跑是查询标签的事。
 * 将要运行的语句一直摆在下面——这里的值是 Cypher 表达式，看一眼语句最能看出写对了没有。
 * 换了实体时由调用方换 `key`，草稿从头来。
 */
export function CypherEntityEditor({
  entity,
  relationship,
  onLink,
  busy,
  error,
  onSave,
  onRevert,
  onDelete,
  onClose
}: CypherEntityEditorProps) {
  const t = useLanguageStore((state) => state.t);
  const [draft, setDraft] = useState<EntityDraft>(() => draftOf(entity));
  const [labelInput, setLabelInput] = useState('');
  const [ends, setEnds] = useState<RelationshipEnds | undefined>(relationship);
  const [type, setType] = useState('');
  const write = useMemo(
    () => (ends ? relationshipCreate(ends, type, draft) : entityWrite(entity, draft)),
    [ends, type, entity, draft]
  );
  const originals = useMemo(() => new Map(entity?.properties ?? []), [entity]);
  const isNode = !ends && (entity === null || entity.kind === 'node');

  const updateProperty = (index: number, change: { key?: string; value?: string }) => setDraft((previous) => ({
    ...previous,
    properties: previous.properties.map((property, at) => (at === index ? { ...property, ...change } : property))
  }));

  const addLabel = () => {
    const label = labelInput.trim();
    if (label && !draft.labels.includes(label)) setDraft((previous) => ({ ...previous, labels: [...previous.labels, label] }));
    setLabelInput('');
  };

  const title = ends
    ? t('cypher.edit.newRelationship')
    : entity === null
    ? t('cypher.edit.newNode')
    : entity.kind === 'node'
      ? t('cypher.edit.node')
      : `${t('cypher.edit.relationship')} :${cypherName(entity.type)}`;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="text-xs font-medium text-fg">{title}</span>
          {entity && <span className="ml-2 select-text font-mono text-xs text-fg-muted">{`elementId: ${entity.elementId}`}</span>}
        </div>
        <button type="button" onClick={onClose} aria-label={t('common.close')} className="text-fg-muted hover:text-fg">
          <X size={14} />
        </button>
      </div>

      {ends && (
        <div className="mb-2 space-y-1">
          <div className="flex flex-wrap items-center gap-1 font-mono text-xs">
            <span className="text-fg">{nodeText(ends.from)}</span>
            <span className="text-fg-muted">-[:</span>
            <input
              {...PLAIN_TEXT_INPUT}
              value={type}
              onChange={(event) => setType(event.target.value)}
              placeholder={t('cypher.edit.relationshipType')}
              aria-label={t('cypher.edit.relationshipType')}
              className="w-36 rounded-control border border-line-strong bg-surface px-1.5 py-0.5 font-mono text-xs"
            />
            <span className="text-fg-muted">]-&gt;</span>
            <span className="text-fg">{nodeText(ends.to)}</span>
            <button
              type="button"
              onClick={() => setEnds({ from: ends.to, to: ends.from })}
              className="ml-1 flex items-center gap-1 rounded-control px-1.5 py-0.5 font-sans text-xs text-accent hover:bg-surface-hover"
            >
              <ArrowLeftRight size={12} />
              {t('cypher.edit.swapDirection')}
            </button>
          </div>
        </div>
      )}

      {isNode && (
        <div className="mb-2 flex flex-wrap items-center gap-1">
          <span className="mr-1 text-xs text-fg-muted">{t('cypher.edit.labels')}</span>
          {draft.labels.map((label) => (
            <span key={label} className="flex items-center gap-0.5 rounded-control bg-accent-soft px-1.5 py-0.5 font-mono text-xs text-accent">
              {`:${cypherName(label)}`}
              <button
                type="button"
                onClick={() => setDraft((previous) => ({ ...previous, labels: previous.labels.filter((item) => item !== label) }))}
                aria-label={t('cypher.edit.removeLabel', { label })}
                className="hover:text-fg"
              >
                <X size={12} />
              </button>
            </span>
          ))}
          <input
            {...PLAIN_TEXT_INPUT}
            value={labelInput}
            onChange={(event) => setLabelInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !isImeKeyEvent(event.nativeEvent)) {
                event.preventDefault();
                addLabel();
              }
            }}
            onBlur={addLabel}
            placeholder={t('cypher.edit.addLabel')}
            aria-label={t('cypher.edit.addLabel')}
            className="w-28 rounded-control border border-line-strong bg-surface px-1.5 py-0.5 font-mono text-xs"
          />
        </div>
      )}

      <div className="mb-1 text-xs text-fg-muted">{t('cypher.edit.properties')}</div>
      <div className="space-y-1">
        {draft.properties.map((property, index) => {
          const original = property.originalKey === null ? undefined : originals.get(property.originalKey);
          const locked = property.value === null;
          return (
            // 次序只会在末尾追加、中间删，下标就是这一行
            <div key={`${property.originalKey ?? 'new'}:${index}`} className="flex items-center gap-1">
              <input
                {...PLAIN_TEXT_INPUT}
                value={property.key}
                onChange={(event) => updateProperty(index, { key: event.target.value })}
                readOnly={locked}
                placeholder={t('cypher.edit.key')}
                aria-label={t('cypher.edit.key')}
                className="w-40 shrink-0 rounded-control border border-line-strong bg-surface px-1.5 py-0.5 font-mono text-xs read-only:opacity-60"
              />
              <input
                {...PLAIN_TEXT_INPUT}
                value={locked ? (original ? formatCypherValue(original, true) : '') : property.value ?? ''}
                onChange={(event) => updateProperty(index, { value: event.target.value })}
                readOnly={locked}
                title={locked ? t('cypher.edit.notEditable') : undefined}
                aria-label={t('cypher.edit.valueOf', { key: property.key })}
                className="min-w-0 flex-1 rounded-control border border-line-strong bg-surface px-1.5 py-0.5 font-mono text-xs read-only:opacity-60"
              />
              <button
                type="button"
                onClick={() => setDraft((previous) => ({ ...previous, properties: previous.properties.filter((_, at) => at !== index) }))}
                aria-label={t('cypher.edit.removeProperty', { key: property.key })}
                className="shrink-0 p-0.5 text-fg-muted hover:text-danger"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setDraft((previous) => ({ ...previous, properties: [...previous.properties, { originalKey: null, key: '', value: '' }] }))}
          className="flex items-center gap-1 text-xs text-accent hover:underline"
        >
          <Plus size={12} />
          {t('cypher.edit.addProperty')}
        </button>
        <span className="text-xs text-fg-subtle">{t('cypher.edit.valueHint')}</span>
      </div>

      {write.kind === 'write' && (
        <pre className="mt-2 select-text whitespace-pre-wrap break-all rounded-control bg-surface px-2 py-1 font-mono text-xs text-fg-muted"><HighlightedCode code={write.statement} language="cypher" /></pre>
      )}
      {write.kind === 'invalid' && <p className="mt-2 text-xs text-warning">{problemText(write.problem, t)}</p>}
      {error && <pre className="mt-2 select-text whitespace-pre-wrap break-words font-mono text-xs text-danger">{error}</pre>}

      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => write.kind === 'write' && onSave(write.statement, write.labelsChanged)}
          disabled={busy || write.kind !== 'write'}
          className="flex items-center gap-1 rounded-control bg-accent px-3 py-1 text-xs text-accent-fg hover:opacity-90 disabled:opacity-50"
        >
          {busy && <Loader2 size={12} className="animate-spin" />}
          {t(ends ? 'cypher.edit.createRelationship' : entity === null ? 'cypher.edit.create' : 'cypher.edit.save')}
        </button>
        {onLink && (
          <button
            type="button"
            onClick={onLink}
            disabled={busy}
            className="flex items-center gap-1 rounded-control border border-line-strong px-3 py-1 text-xs text-fg hover:bg-surface-hover disabled:opacity-50"
          >
            <Spline size={12} />
            {t('cypher.edit.linkFrom')}
          </button>
        )}
        {entity && (
          <button
            type="button"
            onClick={() => (onRevert ? onRevert() : setDraft(draftOf(entity)))}
            disabled={busy || (write.kind === 'unchanged' && !onRevert)}
            className="rounded-control border border-line-strong px-3 py-1 text-xs text-fg hover:bg-surface-hover disabled:opacity-50"
          >
            {t('cypher.edit.revert')}
          </button>
        )}
        {entity && (
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="ml-auto flex items-center gap-1 rounded-control px-3 py-1 text-xs text-danger hover:bg-danger-soft disabled:opacity-50"
          >
            <Trash2 size={12} />
            {t(entity.kind === 'node' ? 'cypher.edit.deleteNode' : 'cypher.edit.deleteRelationship')}
          </button>
        )}
      </div>
    </div>
  );
}

/** 关系一头的样子：标签加 elementId，与结果里认节点的写法一致 */
function nodeText(node: CypherNodeValue): string {
  return `(${node.labels.map((label) => `:${cypherName(label)}`).join('')} ${node.elementId})`;
}

function problemText(problem: DraftProblem, t: (key: TranslationKey, params?: TranslationParams) => string): string {
  switch (problem.kind) {
    case 'empty-type':
      return t('cypher.edit.problem.emptyType');
    case 'empty-key':
      return t('cypher.edit.problem.emptyKey');
    case 'duplicate-key':
      return t('cypher.edit.problem.duplicateKey', { key: problem.key });
    case 'empty-value':
      return t('cypher.edit.problem.emptyValue', { key: problem.key });
  }
}
