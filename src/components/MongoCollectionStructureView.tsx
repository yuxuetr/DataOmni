import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { useQueryStore } from '../stores/queryStore';
import { useLanguageStore } from '../stores/languageStore';
import { describeError } from '../utils/describeError';

interface MongoIndex {
  name: string;
  keys: string;
  options: string;
}

interface MongoCollectionStructure {
  indexes: MongoIndex[];
  options: string;
}

interface MongoCollectionStructureViewProps {
  database: string;
  collection: string;
  /** 视图没有索引；说明文字不一样 */
  isView: boolean;
}

/**
 * MongoDB 集合的结构页：索引与建集合时的选项（校验规则、上限、时序、视图定义）。
 *
 * 只读。值都是后端按 mongosh 写法格式化好的原样文字，这里不做二次解释——
 * 一个新版本服务端多出来的索引选项，照样会出现在「选项」那一列里。
 */
export function MongoCollectionStructureView({ database, collection, isView }: MongoCollectionStructureViewProps) {
  const t = useLanguageStore((state) => state.t);
  const connectionString = useQueryStore((state) => state.connectionString);
  const timeoutMs = useQueryStore((state) => state.queryTimeoutMs);
  const [structure, setStructure] = useState<MongoCollectionStructure | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    if (!connectionString) {
      return;
    }
    const current = ++request.current;
    setLoading(true);
    setError(null);
    try {
      const loaded = await invoke<MongoCollectionStructure>('mongodb_collection_structure', {
        connectionString,
        database,
        collection,
        timeoutMs
      });
      if (current === request.current) {
        setStructure(loaded);
      }
    } catch (cause) {
      if (current === request.current) {
        setStructure(null);
        setError(describeError(cause));
      }
    } finally {
      if (current === request.current) {
        setLoading(false);
      }
    }
  }, [connectionString, database, collection, timeoutMs]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="flex items-center justify-between border-b bg-surface-sunken p-4">
        <h2 className="truncate text-sm font-semibold text-fg" title={`${database}.${collection}`}>
          {t('tab.structureTitle', { table: `${database}.${collection}` })}
        </h2>
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
        <div className="flex items-center gap-2 border-b border-danger-line bg-danger-soft px-4 py-2">
          <AlertCircle className="shrink-0 text-danger" size={14} />
          <span className="text-sm text-danger">{error}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-6 overflow-auto p-4">
        {loading && !structure && (
          <div className="flex items-center gap-2 text-sm text-fg-muted">
            <RefreshCw className="animate-spin text-fg-subtle" size={14} />
            {t('mongo.loading')}
          </div>
        )}

        {structure && (
          <>
            <section>
              <h3 className="mb-2 text-sm font-semibold text-fg">
                {t('mongo.structure.indexes')}
                {!isView && <span className="ml-2 font-normal text-fg-muted">({structure.indexes.length})</span>}
              </h3>
              {isView ? (
                <p className="text-sm text-fg-muted">{t('mongo.structure.viewHasNoIndexes')}</p>
              ) : (
                <table className="w-full table-auto border-collapse text-left">
                  <thead className="bg-surface-sunken">
                    <tr>
                      <th className="border-b border-line px-2 py-1 text-xs font-medium text-fg">{t('mongo.structure.name')}</th>
                      <th className="border-b border-line px-2 py-1 text-xs font-medium text-fg">{t('mongo.structure.keys')}</th>
                      <th className="border-b border-line px-2 py-1 text-xs font-medium text-fg">{t('mongo.structure.options')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {structure.indexes.map((index) => (
                      <tr key={index.name}>
                        <td className="whitespace-nowrap px-2 py-1 font-mono text-[13px] text-fg">{index.name}</td>
                        <td className="px-2 py-1 font-mono text-[13px] text-fg">{index.keys}</td>
                        <td className="px-2 py-1 font-mono text-[13px] text-fg-muted">{index.options}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-sm font-semibold text-fg">
                {isView ? t('mongo.structure.viewDefinition') : t('mongo.structure.collectionOptions')}
              </h3>
              {structure.options ? (
                <pre className="select-text overflow-auto rounded-control border border-line bg-surface-sunken p-3 font-mono text-[13px] text-fg">
                  {structure.options}
                </pre>
              ) : (
                <p className="text-sm text-fg-muted">{t('mongo.structure.noOptions')}</p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
