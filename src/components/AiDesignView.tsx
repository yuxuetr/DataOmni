import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, Loader2, Sparkles } from 'lucide-react';
import { clsx } from 'clsx';
import type { ConnectionProfile } from '../contracts';
import type { TranslationKey } from '../i18n/translate';
import { useAiDesignStore, selectAiDesign } from '../stores/aiDesignStore';
import { useAppStore } from '../stores/appStore';
import { useLanguageStore } from '../stores/languageStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useCompletionCatalog } from '../hooks/useCompletionCatalog';
import { buildDesignMessages, parseDraftResponse } from '../utils/aiDesign';
import { aiConfigured } from '../utils/aiSettings';
import { describeError } from '../utils/describeError';
import {
  buildCreateSchema,
  draftToEr,
  validateSchemaDraft,
  type CreatableDialect,
  type ForeignKeyDraft,
  type SchemaDraft,
  type SchemaIssue,
  type SchemaIssueCode
} from '../utils/schemaDraft';
import { identifierDialectFor } from '../utils/sqlIdentifiers';
import { DdlPreviewDialog } from './DdlPreviewDialog';
import { ErDiagramCanvas } from './ErDiagramView';
import { PLAIN_TEXT_INPUT } from './FormControls';

interface AiDesignViewProps {
  tabId: string;
  connection: ConnectionProfile;
}

/** 写成完整的 Record：校验新增一种问题时这里编译不过 */
const ISSUE_KEYS: Record<SchemaIssueCode, TranslationKey> = {
  'no-tables': 'aiDesign.issue.no-tables',
  'empty-name': 'aiDesign.issue.empty-name',
  'duplicate-table': 'aiDesign.issue.duplicate-table',
  'table-exists': 'aiDesign.issue.table-exists',
  'no-columns': 'aiDesign.issue.no-columns',
  'duplicate-column': 'aiDesign.issue.duplicate-column',
  'missing-type': 'aiDesign.issue.missing-type',
  'name-too-long': 'aiDesign.issue.name-too-long',
  'unknown-column': 'aiDesign.issue.unknown-column',
  'unknown-table': 'aiDesign.issue.unknown-table',
  'references-existing-table': 'aiDesign.issue.references-existing-table',
  'column-count-mismatch': 'aiDesign.issue.column-count-mismatch',
  'reference-not-unique': 'aiDesign.issue.reference-not-unique',
  'set-null-on-not-null': 'aiDesign.issue.set-null-on-not-null',
  'on-delete-unsupported': 'aiDesign.issue.on-delete-unsupported',
  'unknown-sequence': 'aiDesign.issue.unknown-sequence',
  'type-mismatch': 'aiDesign.issue.type-mismatch',
  'no-primary-key': 'aiDesign.issue.no-primary-key',
  'cycle-unsupported': 'aiDesign.issue.cycle-unsupported'
};

const ON_DELETE_CHOICES: Array<{ value: ForeignKeyDraft['onDelete']; labelKey: TranslationKey }> = [
  { value: null, labelKey: 'aiDesign.onDelete.restrict' },
  { value: 'cascade', labelKey: 'aiDesign.onDelete.cascade' },
  { value: 'set null', labelKey: 'aiDesign.onDelete.setNull' }
];

/**
 * 用一句话需求让 AI 设计新表：看校验结果、ER 图与外键的删除行为，确认后建。
 *
 * 界面的重心按 A0 实验定（rfcs/ai-design-and-export.md §2.5）：一次通过率高，所以「回给 AI 修」
 * 就是再按一次按钮；真正的风险是 CASCADE 用得太多，所以外键单列一块、CASCADE 标红、一格就能改。
 */
export function AiDesignView({ tabId, connection }: AiDesignViewProps) {
  const t = useLanguageStore((state) => state.t);
  const settings = useSettingsStore((state) => state.ai);
  const design = useAiDesignStore(selectAiDesign(tabId));
  const update = useAiDesignStore((state) => state.update);
  const markSchemaChanged = useAppStore((state) => state.markSchemaChanged);
  const { relations } = useCompletionCatalog(connection);
  // 入口只在能建表的连接上出现（App 与对象树按 structureEditing 判），这里的断言有依据
  const dialect = identifierDialectFor(connection.db_type) as CreatableDialect;
  const existingTables = useMemo(
    () => relations.filter((relation) => relation.kind === 'table').map((relation) => relation.name),
    [relations]
  );

  const [running, setRunning] = useState(false);
  const [preview, setPreview] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [created, setCreated] = useState<number | null>(null);

  const { draft } = design;
  const issues = useMemo(
    () => (draft ? validateSchemaDraft(draft, dialect, existingTables) : []),
    [draft, dialect, existingTables]
  );
  const errors = issues.filter((issue) => issue.severity === 'error');
  const statements = useMemo(
    () => (draft && errors.length === 0 ? buildCreateSchema(draft, dialect) : []),
    [draft, dialect, errors.length]
  );
  const diagram = useMemo(() => (draft ? draftToEr(draft) : null), [draft]);
  const configured = aiConfigured(settings);

  const generate = async () => {
    const messages = buildDesignMessages(design.requirement, dialect, existingTables, draft);
    update(tabId, { sent: messages, error: null, rawReply: null });
    setCreated(null);
    setRunning(true);
    try {
      const reply = await invoke<string>('ai_complete', {
        request: {
          protocol: settings.protocol,
          baseUrl: settings.baseUrl,
          model: settings.model,
          system: messages.system,
          user: messages.user
        }
      });
      const parsed = parseDraftResponse(reply);
      if (parsed.ok) {
        update(tabId, { draft: parsed.draft });
      } else {
        update(tabId, {
          rawReply: reply,
          error: t(parsed.reason === 'not-json' ? 'aiDesign.replyNotJson' : 'aiDesign.replyBadShape', { detail: parsed.detail })
        });
      }
    } catch (caught) {
      // 钥匙串里没有 Key 时后端报的是通用的「凭据缺失」，那句文案说的是连接密码
      const message = (caught as { message?: unknown })?.message;
      const keyMissing = typeof message === 'string' && message.startsWith('DATAOMNI_CREDENTIAL_MISSING');
      update(tabId, { error: keyMissing ? t('aiDesign.keyMissing') : describeError(caught) });
    } finally {
      setRunning(false);
    }
  };

  const setOnDelete = (tableIndex: number, keyIndex: number, onDelete: ForeignKeyDraft['onDelete']) => {
    if (!draft) return;
    const next: SchemaDraft = {
      tables: draft.tables.map((table, index) => index !== tableIndex ? table : {
        ...table,
        foreignKeys: table.foreignKeys.map((key, position) => position === keyIndex ? { ...key, onDelete } : key)
      })
    };
    update(tabId, { draft: next });
  };

  const apply = async () => {
    setApplying(true);
    setApplyError(null);
    try {
      await invoke<number[]>('execute_write_batch', {
        connectionId: connection.id,
        statements: statements.map((sql) => ({ sql, params: [], expectRows: null }))
      });
      markSchemaChanged();
      setCreated(draft?.tables.length ?? 0);
      setPreview(false);
      update(tabId, { draft: null });
    } catch (caught) {
      const index = (caught as { statement_index?: unknown })?.statement_index;
      const detail = describeError(caught);
      setApplyError(typeof index === 'number' ? t('aiDesign.failedAt', { index: index + 1, detail }) : detail);
    } finally {
      setApplying(false);
    }
  };

  const foreignKeys = draft?.tables.flatMap((table, tableIndex) =>
    table.foreignKeys.map((key, keyIndex) => ({ table, key, tableIndex, keyIndex }))) ?? [];

  return (
    <div className="flex h-full min-h-0">
      {/* 块级而不是 flex 列：flex 列里内容一多，需求框会被挤成一条线（打包版上见过），块级只会让这一栏滚动 */}
      <div className="w-[420px] shrink-0 space-y-3 overflow-y-auto border-r border-line p-4">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-accent" />
          <h2 className="text-sm font-medium text-fg">{t('aiDesign.title')}</h2>
          <span className="ml-auto text-xs text-fg-subtle">{connection.name} · {dialect}</span>
        </div>

        {!configured && (
          <p className="rounded-control border border-warning-line bg-warning-soft px-3 py-2 text-xs text-warning">
            {t('aiDesign.notConfigured')}
          </p>
        )}

        <textarea
          value={design.requirement}
          onChange={(event) => update(tabId, { requirement: event.target.value })}
          placeholder={draft ? t('aiDesign.revisePlaceholder') : t('aiDesign.requirementPlaceholder')}
          aria-label={t('aiDesign.requirement')}
          rows={4}
          className="w-full resize-y rounded-control border border-line-strong bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent"
          {...PLAIN_TEXT_INPUT}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void generate()}
            disabled={!configured || running || design.requirement.trim() === ''}
            className="flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:opacity-90 disabled:opacity-50"
          >
            {running && <Loader2 size={14} className="animate-spin" />}
            {draft ? t('aiDesign.revise') : t('aiDesign.generate')}
          </button>
          {draft && (
            <button
              type="button"
              onClick={() => update(tabId, { draft: null, sent: null, rawReply: null, error: null })}
              disabled={running}
              className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover disabled:opacity-50"
            >
              {t('aiDesign.discard')}
            </button>
          )}
        </div>

        {design.sent && (
          <details className="text-xs text-fg-muted">
            <summary className="cursor-pointer select-none">{t('aiDesign.sent')}</summary>
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-control border border-line bg-surface-sunken p-2 font-mono text-fg select-text">
              {`[system]\n${design.sent.system}\n\n[user]\n${design.sent.user}`}
            </pre>
          </details>
        )}

        {design.error && (
          <div className="rounded-control border border-danger-line bg-danger-soft px-3 py-2 text-xs text-danger">
            <p className="break-words">{design.error}</p>
            {design.rawReply && (
              <details className="mt-1">
                <summary className="cursor-pointer select-none">{t('aiDesign.rawReply')}</summary>
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono select-text">{design.rawReply}</pre>
              </details>
            )}
          </div>
        )}

        {created !== null && (
          <p className="rounded-control border border-line bg-surface-sunken px-3 py-2 text-xs text-success">
            {t('aiDesign.created', { count: created })}
          </p>
        )}

        {draft && (
          <>
            <IssueList issues={issues} />

            {foreignKeys.length > 0 && (
              <section>
                <h3 className="mb-1 text-xs font-medium text-fg-muted">{t('aiDesign.foreignKeys')}</h3>
                <ul className="space-y-1">
                  {foreignKeys.map(({ table, key, tableIndex, keyIndex }) => (
                    <li
                      key={`${tableIndex}:${keyIndex}`}
                      className={clsx(
                        'flex items-center gap-2 rounded-control border px-2 py-1 text-xs',
                        key.onDelete === 'cascade' ? 'border-danger-line bg-danger-soft' : 'border-line'
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono text-fg" title={`${table.name}.${key.columns.join(', ')} → ${key.referencedTable}`}>
                        {table.name}.{key.columns.join(', ')} → {key.referencedTable}
                      </span>
                      <select
                        value={key.onDelete ?? ''}
                        onChange={(event) => setOnDelete(tableIndex, keyIndex, (event.target.value || null) as ForeignKeyDraft['onDelete'])}
                        aria-label={t('aiDesign.onDelete')}
                        className="shrink-0 rounded-control border border-line-strong bg-surface px-1 py-0.5 text-xs text-fg"
                      >
                        {ON_DELETE_CHOICES.map((choice) => (
                          <option key={choice.labelKey} value={choice.value ?? ''}>{t(choice.labelKey)}</option>
                        ))}
                      </select>
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-xs text-fg-subtle">{t('aiDesign.cascadeHint')}</p>
              </section>
            )}

            <button
              type="button"
              onClick={() => {
                setApplyError(null);
                setPreview(true);
              }}
              disabled={errors.length > 0 || statements.length === 0}
              className="rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:opacity-90 disabled:opacity-50"
            >
              {t('aiDesign.previewDdl', { count: draft.tables.length })}
            </button>
          </>
        )}
      </div>

      <div className="min-w-0 flex-1">
        {diagram ? (
          <ErDiagramCanvas tables={diagram.tables} links={diagram.links} />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-center text-sm text-fg-muted">
            {t('aiDesign.empty')}
          </div>
        )}
      </div>

      {preview && (
        <DdlPreviewDialog
          plan={{ statements, refusals: [], impacts: [] }}
          dialect={dialect}
          running={applying}
          error={applyError}
          onApply={() => void apply()}
          onClose={() => !applying && setPreview(false)}
        />
      )}
    </div>
  );
}

function IssueList({ issues }: { issues: SchemaIssue[] }) {
  const t = useLanguageStore((state) => state.t);
  if (issues.length === 0) {
    return <p className="text-xs text-success">{t('aiDesign.noIssues')}</p>;
  }
  return (
    <ul className="space-y-1">
      {issues.map((issue, index) => (
        <li
          key={index}
          className={clsx('flex gap-1.5 text-xs', issue.severity === 'error' ? 'text-danger' : 'text-warning')}
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          <span className="break-words">
            <span className="font-mono">{issue.column ? `${issue.table}.${issue.column}` : issue.table}</span>
            {' · '}
            {t(ISSUE_KEYS[issue.code], { detail: issue.detail })}
          </span>
        </li>
      ))}
    </ul>
  );
}
