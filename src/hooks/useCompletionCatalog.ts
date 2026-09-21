import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { CompletionRelation, ConnectionProfile } from '../contracts';
import { useAppStore } from '../stores/appStore';
import { useQueryStore } from '../stores/queryStore';
import { describeError } from '../utils/describeError';
import { requireDatabase } from '../utils/requireDatabase';
import { normalizeCompletionRows } from '../utils/sqlCompletionSchema';
import { translateNow } from '../stores/languageStore';

/** `get_completion_catalog_query` 的返回；字段名按 Rust 侧的 snake_case */
interface CompletionCatalogQuery {
  relations: string;
  parameter_count: number;
}

const NO_RELATIONS: CompletionRelation[] = [];

export interface CompletionCatalogState {
  relations: CompletionRelation[];
  /** 加载失败的原因。补全只剩关键字时必须说得出为什么。 */
  error: string | null;
}

/**
 * 整库的关系与列，供 SQL 补全使用。
 *
 * 缓存放在 appStore 而不是组件里：一次只渲染活动标签，编辑器会随切标签
 * 卸载，存在组件里等于每切一次标签就把整库的列重查一遍。
 *
 * 失效条件是 `schemaVersion`——我们自己执行过改结构的语句就重拉。外部改动
 * 和对象树一样靠重新连接或刷新。
 */
export function useCompletionCatalog(connection: ConnectionProfile): CompletionCatalogState {
  const database = useQueryStore((state) => state.database);
  const schemaVersion = useAppStore((state) => state.schemaVersion);
  const cached = useAppStore((state) => state.completionCatalogs[connection.id]);
  const setCompletionCatalog = useAppStore((state) => state.setCompletionCatalog);

  const [error, setError] = useState<string | null>(null);
  const isFresh = cached?.schemaVersion === schemaVersion;

  useEffect(() => {
    if (!database || isFresh) {
      return;
    }

    let cancelled = false;

    const load = async () => {
      try {
        const query = await invoke<CompletionCatalogQuery>('get_completion_catalog_query', {
          dbType: connection.db_type
        });

        // 没有库名时 `TABLE_SCHEMA = NULL` 恒不匹配，会安静地查出 0 行，
        // 看上去就像这个库一张表也没有。
        if (query.parameter_count > 0 && !connection.database) {
          throw new Error(translateNow('completion.noDatabaseName'));
        }
        const params = Array.from(
          { length: query.parameter_count },
          () => connection.database
        );

        const rows = await requireDatabase(database).select(query.relations, params);
        if (cancelled) {
          return;
        }

        setCompletionCatalog(connection.id, {
          relations: normalizeCompletionRows(Array.isArray(rows) ? rows : []),
          schemaVersion
        });
        setError(null);
      } catch (err) {
        if (cancelled) {
          return;
        }
        // 目录拿不到不该打断写 SQL：补全退回只剩关键字，但这件事要说出来，
        // 否则「它不认识我的表」和「它还在加载」长得一模一样。
        console.warn('加载 SQL 补全目录失败:', err);
        setError(describeError(err));
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [
    connection.id,
    connection.db_type,
    connection.database,
    database,
    isFresh,
    schemaVersion,
    setCompletionCatalog
  ]);

  return { relations: cached?.relations ?? NO_RELATIONS, error };
}
