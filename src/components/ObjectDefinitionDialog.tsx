import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useQueryStore } from '../stores/queryStore';
import { describeError } from '../utils/describeError';
import { KIND_LABEL_KEYS, type DatabaseObject } from '../utils/databaseObjects';
import { useLanguageStore } from '../stores/languageStore';
import type { ConnectionProfile } from '../contracts';
import type { ObjectCatalogQueries } from './DatabaseExplorer';
import { requireDatabase } from '../utils/requireDatabase';
import { ddlRequest, type SchemaMetadataQueries } from '../utils/catalogQueries';
import { extractDdlStatements, joinDdlStatements } from '../utils/schemaObjects';
import { identifierDialectFor } from '../utils/sqlIdentifiers';

interface ObjectDefinitionDialogProps {
  object: DatabaseObject;
  connection: ConnectionProfile;
  onClose: () => void;
}

/**
 * 除了表以外，每种对象的定义都在这里看。
 *
 * 函数、存储过程、序列**没有行**，用表视图打开只会查询失败；它们真正能看的
 * 就是定义本身。视图有行，但它的主体同样是那段 SELECT——而结构页是个可编辑
 * 的编辑器，不认视图，于是视图在此之前**一条看定义的路都没有**。
 *
 * 三类各有各的来源，都是数据库自己吐出来的原文，不是我们从目录拼的：
 * - 例程：`pg_get_functiondef` / `INFORMATION_SCHEMA.ROUTINES`
 * - 视图与物化视图：`pg_get_viewdef` / `SHOW CREATE TABLE` / `sqlite_master`，
 *   和结构页里那段「对象定义」走的是同一条查询
 * - 序列没有 `CREATE SEQUENCE` 的反解函数，但 `pg_sequences` 直接给出定义它的
 *   全部属性——如实列属性，不去拼一条可能不等价的 CREATE SEQUENCE
 */
export function ObjectDefinitionDialog({
  object,
  connection,
  onClose
}: ObjectDefinitionDialogProps) {
  const { database } = useQueryStore();
  const t = useLanguageStore((state) => state.t);
  const [definition, setDefinition] = useState<string | null>(null);
  const [properties, setProperties] = useState<Array<[string, string]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        if (object.kind === 'view' || object.kind === 'materialized-view') {
          const metadata = await invoke<SchemaMetadataQueries>('get_schema_metadata_queries', {
            dbType: connection.db_type
          });
          // ddl 为 null 表示这个方言给不出定义原文。留空让下面显示「数据库没有
          // 返回定义」——那是实话，而拼一段我们自己的 CREATE VIEW 不是
          const request = metadata.ddl && ddlRequest(
            metadata.ddl,
            metadata.parameter_count,
            object.name,
            object.schema,
            identifierDialectFor(connection.db_type)
          );
          const rows = request
            ? await requireDatabase(database).select(request.sql, request.params)
            : [];
          if (!cancelled) {
            setDefinition(joinDdlStatements(extractDdlStatements(Array.isArray(rows) ? rows : [])));
          }
          return;
        }

        const queries = await invoke<ObjectCatalogQueries>('get_object_catalog_queries', {
          dbType: connection.db_type
        });

        if (object.kind === 'sequence') {
          if (!queries.sequence_properties) {
            throw new Error(t('objectDefinition.noSequences'));
          }
          const rows = await requireDatabase(database).select(queries.sequence_properties, [object.id]);
          const row = Array.isArray(rows) ? rows[0] : undefined;
          if (!cancelled) {
            setProperties(row ? Object.entries(row).map(([key, value]) => [key, String(value)]) : []);
          }
          return;
        }

        // PostgreSQL 按 oid 绑一个参数；MySQL 要名字加库名两个
        const params = connection.db_type === 'postgresql'
          ? [object.id]
          : [object.id, connection.database ?? null];
        const rows = await requireDatabase(database).select(queries.routine_definition, params);
        const row = Array.isArray(rows) ? rows[0] : undefined;
        const text = row ? String(Object.values(row)[0] ?? '') : '';
        if (!cancelled) {
          setDefinition(text);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(describeError(cause, t('objectDefinition.readFailed')));
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [object, connection, database, t]);

  const copyText = definition
    ?? properties?.map(([key, value]) => `${key}: ${value}`).join('\n')
    ?? '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (cause) {
      // 剪贴板可能被权限或非安全上下文拒绝；静默失败会让人以为复制成功了
      setError(describeError(cause, t('common.copyFailed')));
    }
  };

  const loading = !error && definition === null && properties === null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="object-definition-title"
      onClick={onClose}
    >
      <div
        className="flex max-h-[calc(100vh-4rem)] w-[640px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-panel bg-surface-raised shadow-xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-5 py-3">
          <h2 id="object-definition-title" className="min-w-0 truncate text-sm font-medium text-fg">
            {object.schema ? `${object.schema}.` : ''}{object.name}
          </h2>
          <span className="shrink-0 rounded-control bg-accent-soft px-1.5 py-0.5 text-xs text-accent">
            {t(KIND_LABEL_KEYS[object.kind])}
          </span>
          {copyText && (
            <button
              type="button"
              onClick={copy}
              className="ml-auto flex shrink-0 items-center gap-1 rounded-control border border-line-strong px-2 py-0.5 text-xs text-fg hover:bg-surface-hover"
            >
              {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
              {copied ? t('common.copied') : t('common.copy')}
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          {loading && (
            <p className="flex items-center gap-2 text-xs text-fg-subtle">
              <Loader2 size={14} className="animate-spin" />
              {t('objectDefinition.loading')}
            </p>
          )}

          {error && <p className="break-words text-xs text-danger">{error}</p>}

          {properties && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-xs">
              {properties.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-fg-muted">{key}</dt>
                  <dd className="text-fg select-text">{value}</dd>
                </div>
              ))}
            </dl>
          )}

          {definition !== null && (
            definition
              ? (
                <pre className="font-mono text-xs text-fg select-text whitespace-pre-wrap break-words">
                  {definition}
                </pre>
              )
              : <p className="text-xs text-fg-subtle">{t('objectDefinition.empty')}</p>
          )}
        </div>

        <div className="flex justify-end border-t border-line bg-surface-sunken px-5 py-3">
          <button
            type="button"
            ref={closeRef}
            onClick={onClose}
            className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg hover:bg-surface-hover"
          >
            {t('objectDefinition.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
