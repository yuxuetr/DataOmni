import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { clsx } from 'clsx';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { useQueryStore } from '../stores/queryStore';
import { useLanguageStore } from '../stores/languageStore';
import { describeError } from '../utils/describeError';
import { PLAIN_TEXT_INPUT } from './FormControls';
import { MAX_UNVIRTUALIZED_ROWS } from '../utils/gridPagination';
import { parseJson, stringifyJson, type JsonValue } from '../utils/esJson';
import {
  filterMappingFields,
  readIndexAliases,
  readIndexMapping,
  readIndexSettings,
  type IndexMapping,
  type IndexSettings,
  type MappingField
} from '../utils/esMapping';
import { HighlightedCode } from './HighlightedCode';

interface EsResponse {
  status: number;
  body: string;
}

interface Loaded {
  raw: JsonValue;
  mapping: IndexMapping;
  settings: IndexSettings | null;
  aliases: string[];
}

interface EsIndexStructureViewProps {
  index: string;
}

/**
 * Elasticsearch 索引的结构页：Mapping 摊成一行一个字段，外加分片、副本、建索引的时刻与别名。
 *
 * 三个都是只读的 GET，走控制台同一个命令；设置与别名要 `view_index_metadata` 权限，
 * 只有 `read` 的账号拿到 403，那两项就不显示——Mapping 本身它能读。
 */
export function EsIndexStructureView({ index }: EsIndexStructureViewProps) {
  const t = useLanguageStore((state) => state.t);
  const connectionString = useQueryStore((state) => state.connectionString);
  const timeoutMs = useQueryStore((state) => state.queryTimeoutMs);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showRaw, setShowRaw] = useState(false);
  const request = useRef(0);

  const load = useCallback(async () => {
    if (!connectionString) return;
    const current = ++request.current;
    setLoading(true);
    setError(null);
    const get = (path: string) => invoke<EsResponse>('elasticsearch_run', {
      connectionString, method: 'GET', path, body: null, ndjson: false, timeoutMs
    });
    const name = encodeURIComponent(index);
    try {
      const [mapping, settings, aliases] = await Promise.all([
        get(`/${name}/_mapping`),
        get(`/${name}/_settings?flat_settings=true`).catch(() => null),
        get(`/${name}/_alias`).catch(() => null)
      ]);
      const raw = parseJson(mapping.body);
      const read = mapping.status < 300 ? readIndexMapping(raw, index) : null;
      if (current !== request.current) return;
      if (!raw || !read) {
        setLoaded(null);
        setError(`HTTP ${mapping.status}: ${mapping.body.slice(0, 500)}`);
        return;
      }
      const ok = (response: EsResponse | null) => (response && response.status < 300 ? parseJson(response.body) : null);
      setLoaded({
        raw,
        mapping: read,
        settings: readIndexSettings(ok(settings), index),
        aliases: readIndexAliases(ok(aliases), index)
      });
    } catch (cause) {
      if (current === request.current) {
        setLoaded(null);
        setError(describeError(cause));
      }
    } finally {
      if (current === request.current) setLoading(false);
    }
  }, [connectionString, index, timeoutMs]);

  useEffect(() => {
    void load();
  }, [load]);

  const fields = useMemo(() => (loaded ? filterMappingFields(loaded.mapping.fields, filter) : []), [loaded, filter]);
  const shown = fields.slice(0, MAX_UNVIRTUALIZED_ROWS);
  const { settings } = loaded ?? {};
  const facts = [
    settings?.shards ? t('es.structure.shards', { n: settings.shards }) : null,
    settings?.replicas ? t('es.structure.replicas', { n: settings.replicas }) : null,
    settings?.createdAt ? t('es.structure.created', { time: new Date(settings.createdAt).toLocaleString() }) : null,
    settings?.uuid ? `uuid ${settings.uuid}` : null
  ].filter((fact): fact is string => fact !== null);

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center justify-between border-b bg-surface-sunken p-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-fg" title={index}>
            {t('tab.structureTitle', { table: index })}
          </h2>
          {facts.length > 0 && <p className="mt-0.5 truncate text-xs text-fg-muted">{facts.join(' · ')}</p>}
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          className="flex items-center gap-1 rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg transition-colors hover:bg-surface-hover disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          <span>{t('explorer.refresh')}</span>
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 border-b border-danger-line bg-danger-soft px-4 py-2">
          <AlertCircle className="mt-0.5 shrink-0 text-danger" size={14} />
          <span className="select-text break-all text-sm text-danger">{error}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-6 overflow-auto p-4">
        {loading && !loaded && (
          <div className="flex items-center gap-2 text-sm text-fg-muted">
            <RefreshCw className="animate-spin text-fg-subtle" size={14} />
            {t('es.structure.loading')}
          </div>
        )}

        {loaded && (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
              <span>{t('es.structure.dynamic', { value: loaded.mapping.dynamic })}</span>
              {loaded.aliases.length > 0 && <span>{t('es.structure.aliases', { names: loaded.aliases.join(', ') })}</span>}
              {loaded.mapping.sourceDisabled && <span className="text-warning">{t('es.structure.sourceDisabled')}</span>}
            </div>

            <section>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-fg">
                {t('es.structure.fields')}
                <span className="font-normal text-fg-muted">({loaded.mapping.fields.length})</span>
                <input
                  type="search"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder={t('es.structure.filter')}
                  aria-label={t('es.structure.filter')}
                  {...PLAIN_TEXT_INPUT}
                  className="ml-auto w-56 rounded-control border border-line-strong bg-surface px-2 py-1 text-xs font-normal text-fg"
                />
              </h3>
              {loaded.mapping.fields.length === 0 ? (
                <p className="text-sm text-fg-muted">{t('es.structure.noFields')}</p>
              ) : (
                <FieldTable fields={shown} />
              )}
              {fields.length > shown.length && (
                <p className="mt-1 text-xs text-fg-muted">{t('es.structure.capped', { shown: shown.length, total: fields.length })}</p>
              )}
            </section>

            {loaded.mapping.runtime.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-semibold text-fg">
                  {t('es.structure.runtime')}
                  <span className="ml-2 font-normal text-fg-muted">({loaded.mapping.runtime.length})</span>
                </h3>
                <FieldTable fields={loaded.mapping.runtime} />
              </section>
            )}

            <section>
              <button type="button" onClick={() => setShowRaw((value) => !value)} className="text-sm font-semibold text-fg hover:text-accent">
                {showRaw ? '▾ ' : '▸ '}
                {t('es.structure.raw')}
              </button>
              {showRaw && (
                <pre className="mt-2 max-h-[32rem] select-text overflow-auto rounded-control border border-line bg-surface-sunken p-3 font-mono text-xs text-fg"><HighlightedCode code={stringifyJson(loaded.raw, 2)} language="json" /></pre>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function FieldTable({ fields }: { fields: readonly MappingField[] }) {
  const t = useLanguageStore((state) => state.t);
  return (
    <table className="w-full table-auto border-collapse text-left">
      <thead className="bg-surface-sunken">
        <tr>
          <th className="border-b border-line px-2 py-1 text-xs font-medium text-fg">{t('es.structure.field')}</th>
          <th className="border-b border-line px-2 py-1 text-xs font-medium text-fg">{t('es.structure.type')}</th>
          <th className="border-b border-line px-2 py-1 text-xs font-medium text-fg">{t('es.structure.details')}</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {fields.map((field) => (
          <tr key={field.path}>
            <td className="whitespace-nowrap px-2 py-1 font-mono text-[13px] text-fg" style={{ paddingLeft: `${0.5 + field.depth * 1.25}rem` }}>
              {field.path}
              {field.multiField && <span className="ml-2 font-sans text-xs text-fg-subtle">{t('es.structure.multiField')}</span>}
            </td>
            <td className={clsx('whitespace-nowrap px-2 py-1 font-mono text-[13px]', field.type === 'object' || field.type === 'nested' ? 'text-fg-muted' : 'text-accent')}>
              {field.type}
            </td>
            <td className="px-2 py-1 font-mono text-[13px] text-fg-muted">
              {field.details.map(([key, value]) => `${key}: ${value}`).join(' · ')}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
