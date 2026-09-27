import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, Loader2, Sparkles } from 'lucide-react';
import type { ConnectionProfile } from '../contracts';
import type { TranslationKey } from '../i18n/translate';
import { selectAiDesign, useAiDesignStore } from '../stores/aiDesignStore';
import { useAppStore } from '../stores/appStore';
import { useLanguageStore } from '../stores/languageStore';
import { useQueryStore } from '../stores/queryStore';
import { useSettingsStore } from '../stores/settingsStore';
import { aiConfigured, completeWithAi, isAiKeyMissing } from '../utils/aiSettings';
import { describeError } from '../utils/describeError';
import {
  buildMongoDesignMessages,
  parseMongoDesign,
  planMongoDesign,
  validateMongoDesign,
  type MongoIssueCode
} from '../utils/mongoDesign';
import { AiRequestPanel } from './AiRequestPanel';
import { HighlightedCode } from './HighlightedCode';
import { PLAIN_TEXT_INPUT } from './FormControls';

/** 写成完整的 Record：校验新增一种问题时这里编译不过 */
const ISSUE_KEYS: Record<MongoIssueCode, TranslationKey> = {
  'no-collections': 'aiDesign.mongoIssue.no-collections',
  'empty-name': 'aiDesign.mongoIssue.empty-name',
  'invalid-name': 'aiDesign.mongoIssue.invalid-name',
  'duplicate-collection': 'aiDesign.mongoIssue.duplicate-collection',
  'collection-exists': 'aiDesign.mongoIssue.collection-exists',
  'schema-wrapped': 'aiDesign.mongoIssue.schema-wrapped',
  'unsupported-keyword': 'aiDesign.mongoIssue.unsupported-keyword',
  'empty-index': 'aiDesign.mongoIssue.empty-index'
};

/** 集合里各字段的一行摘要：名字、bsonType、必填。看结构用，完整的规则在展开的 JSON 里 */
function fieldSummary(schema: Record<string, unknown>): Array<{ name: string; type: string; required: boolean }> {
  const properties = schema.properties;
  if (typeof properties !== 'object' || properties === null) {
    return [];
  }
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  return Object.entries(properties as Record<string, unknown>).map(([name, value]) => {
    const bsonType = (value as { bsonType?: unknown } | null)?.bsonType;
    return {
      name,
      type: Array.isArray(bsonType) ? bsonType.join(' | ') : typeof bsonType === 'string' ? bsonType : '',
      required: required.has(name)
    };
  });
}

interface AiMongoDesignViewProps {
  tabId: string;
  connection: ConnectionProfile;
}

/**
 * MongoDB 的 AI 设计：集合与它的 `$jsonSchema` 校验规则、索引。没有外键可画，
 * 所以不画图，每个集合列出字段摘要、可以展开看完整的规则（TODOs 下一步规划 A9）
 */
export function AiMongoDesignView({ tabId, connection }: AiMongoDesignViewProps) {
  const t = useLanguageStore((state) => state.t);
  const settings = useSettingsStore((state) => state.ai);
  const design = useAiDesignStore(selectAiDesign(tabId));
  const update = useAiDesignStore((state) => state.update);
  const markSchemaChanged = useAppStore((state) => state.markSchemaChanged);
  const objects = useAppStore((state) => state.databaseMetadata[connection.id]?.objects);
  const connectionString = useQueryStore((state) => state.connectionString);
  const timeoutMs = useQueryStore((state) => state.queryTimeoutMs);

  const databases = useMemo(
    () => [...new Set((objects ?? []).map((object) => object.schema).filter((name): name is string => !!name))].sort(),
    [objects]
  );
  const [database, setDatabase] = useState(connection.database || databases[0] || '');
  const existing = useMemo(
    () => (objects ?? []).filter((object) => object.schema === database).map((object) => object.name),
    [objects, database]
  );

  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [created, setCreated] = useState<number | null>(null);

  const draft = design.mongoDraft;
  const issues = useMemo(() => (draft ? validateMongoDesign(draft, existing) : []), [draft, existing]);
  const steps = useMemo(
    () => (draft && issues.length === 0 && database.trim() !== '' ? planMongoDesign(draft, database.trim()) : []),
    [draft, issues.length, database]
  );
  const configured = aiConfigured(settings);

  const generate = async () => {
    const messages = buildMongoDesignMessages(design.requirement, existing, draft);
    update(tabId, { sent: messages, error: null, rawReply: null });
    setCreated(null);
    setRunning(true);
    try {
      const reply = await completeWithAi(settings, messages);
      const parsed = parseMongoDesign(reply);
      if (parsed.ok) {
        update(tabId, { mongoDraft: parsed.design });
      } else {
        update(tabId, {
          rawReply: reply,
          error: t(parsed.reason === 'not-json' ? 'aiDesign.replyNotJson' : 'aiDesign.replyBadShape', { detail: parsed.detail })
        });
      }
    } catch (caught) {
      update(tabId, { error: isAiKeyMissing(caught) ? t('aiDesign.keyMissing') : describeError(caught) });
    } finally {
      setRunning(false);
    }
  };

  // 一步一步发：MongoDB 没有 DDL 事务，停在哪一步要说得出来，前面建好的就在那里
  const apply = async () => {
    if (!connectionString) {
      return;
    }
    setApplying(true);
    setApplyError(null);
    let done = 0;
    try {
      for (const step of steps) {
        if (step.kind === 'collection') {
          await invoke('mongodb_create_collection', {
            connectionString,
            database: database.trim(),
            collection: step.collection,
            options: step.document,
            timeoutMs
          });
        } else {
          await invoke('mongodb_create_index', {
            connectionString,
            database: database.trim(),
            collection: step.collection,
            keys: step.document,
            options: step.options,
            timeoutMs
          });
        }
        done += 1;
      }
      markSchemaChanged();
      setCreated(draft?.collections.length ?? 0);
      update(tabId, { mongoDraft: null });
    } catch (caught) {
      markSchemaChanged();
      setApplyError(t('aiDesign.mongoFailedAt', { index: done + 1, done, detail: describeError(caught) }));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="w-[420px] shrink-0 space-y-3 overflow-y-auto border-r border-line p-4">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-accent" />
          <h2 className="text-sm font-medium text-fg">{t('aiDesign.title')}</h2>
          <span className="ml-auto text-xs text-fg-subtle">{connection.name} · MongoDB</span>
        </div>

        <label className="flex items-center gap-2 text-xs text-fg-muted">
          <span className="shrink-0">{t('aiDesign.mongoDatabase')}</span>
          <input
            value={database}
            onChange={(event) => setDatabase(event.target.value)}
            list={`${tabId}-databases`}
            aria-label={t('aiDesign.mongoDatabase')}
            className="min-w-0 flex-1 rounded-control border border-line-strong bg-surface px-2 py-1 font-mono text-xs text-fg outline-none focus:border-accent"
            {...PLAIN_TEXT_INPUT}
          />
          <datalist id={`${tabId}-databases`}>
            {databases.map((name) => <option key={name} value={name} />)}
          </datalist>
        </label>

        <AiRequestPanel
          requirement={design.requirement}
          onRequirementChange={(requirement) => update(tabId, { requirement })}
          hasDraft={draft !== null}
          configured={configured}
          running={running}
          onGenerate={() => void generate()}
          onDiscard={() => update(tabId, { mongoDraft: null, sent: null, rawReply: null, error: null })}
          sent={design.sent}
          error={design.error}
          rawReply={design.rawReply}
        />

        {created !== null && (
          <p className="rounded-control border border-line bg-surface-sunken px-3 py-2 text-xs text-success">
            {t('aiDesign.mongoCreated', { count: created, database })}
          </p>
        )}

        {draft && (
          <>
            {issues.length === 0 ? (
              <p className="text-xs text-success">{t('aiDesign.noIssues')}</p>
            ) : (
              <ul className="space-y-1">
                {issues.map((issue, index) => (
                  <li key={index} className="flex gap-1.5 text-xs text-danger">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span className="break-words">
                      <span className="font-mono">{issue.collection}</span>
                      {issue.collection && ' · '}
                      {t(ISSUE_KEYS[issue.code], { detail: issue.detail })}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {steps.length > 0 && (
              <details className="text-xs text-fg-muted">
                <summary className="cursor-pointer select-none">{t('aiDesign.mongoSteps', { count: steps.length })}</summary>
                <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-control border border-line bg-surface-sunken p-2 font-mono text-fg select-text">
                  <HighlightedCode code={steps.map((step) => step.command).join('\n')} language="javascript" />
                </pre>
              </details>
            )}
            <p className="text-xs text-fg-subtle">{t('aiDesign.mongoNoTransaction')}</p>

            <button
              type="button"
              onClick={() => void apply()}
              disabled={applying || steps.length === 0 || !connectionString}
              className="flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:opacity-90 disabled:opacity-50"
            >
              {applying && <Loader2 size={14} className="animate-spin" />}
              {t('aiDesign.mongoApply', { count: draft.collections.length })}
            </button>
            {applyError && <p className="break-words text-xs text-danger">{applyError}</p>}
          </>
        )}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto p-4">
        {!draft ? (
          <div className="flex h-full items-center justify-center p-8 text-center text-sm text-fg-muted">
            {t('aiDesign.empty')}
          </div>
        ) : (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(280px,1fr))]">
            {draft.collections.map((collection) => (
              <section key={collection.name} className="rounded-panel border border-line bg-surface">
                <h3 className="border-b border-line px-3 py-2 font-mono text-sm text-fg">{collection.name}</h3>
                <ul className="px-3 py-2 text-xs">
                  {fieldSummary(collection.jsonSchema).map((field) => (
                    <li key={field.name} className="flex gap-2 py-0.5">
                      <span className="min-w-0 flex-1 truncate font-mono text-fg">
                        {field.name}{field.required && <span className="text-danger">*</span>}
                      </span>
                      <span className="shrink-0 text-fg-subtle">{field.type}</span>
                    </li>
                  ))}
                </ul>
                {collection.indexes.length > 0 && (
                  <p className="border-t border-line px-3 py-1.5 font-mono text-[11px] text-fg-muted">
                    {collection.indexes.map((index) => `${JSON.stringify(index.keys)}${index.unique ? ' unique' : ''}`).join(' · ')}
                  </p>
                )}
                <details className="border-t border-line px-3 py-1.5 text-xs text-fg-muted">
                  <summary className="cursor-pointer select-none">$jsonSchema</summary>
                  <pre className="mt-1 max-h-60 overflow-auto font-mono text-[11px] text-fg select-text">
                    <HighlightedCode code={JSON.stringify(collection.jsonSchema, null, 2)} language="json" />
                  </pre>
                </details>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
