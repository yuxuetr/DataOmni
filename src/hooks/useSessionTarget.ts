import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ConnectionProfile } from '../contracts';
import { useQueryStore } from '../stores/queryStore';
import { requireDatabase } from '../utils/requireDatabase';
import {
  normalizeSessionTarget,
  UNKNOWN_SESSION_TARGET,
  type SessionTarget
} from '../utils/sessionTarget';

/** `get_session_target_query` 的返回 */
interface SessionTargetQuery {
  sql: string;
}

/**
 * 问服务端：新查询默认落在哪个库、哪个 schema，是不是只读。
 *
 * 只在连上之后问一次。**不做实时刷新**，因为刷新出来的东西不可信：连接池
 * 最多 10 条连接，`SET search_path` 只改动其中一条，再查一次可能落在另一条
 * 上，界面会在两个值之间闪。一个会闪的指示器比一个固定的更糟——固定的至少
 * 说得清它是什么。
 *
 * MySQL 上这一栏恒等于连上去时选定的库：`USE` 走不了预处理协议（错误 1295），
 * 而应用的执行器正是预处理的。见 `database_smoke.rs` 里
 * `mysql_use_is_rejected_by_the_prepared_protocol`。
 */
export function useSessionTarget(connection: ConnectionProfile): SessionTarget {
  const database = useQueryStore((state) => state.database);
  const [target, setTarget] = useState<SessionTarget>(UNKNOWN_SESSION_TARGET);

  useEffect(() => {
    if (!database) {
      setTarget(UNKNOWN_SESSION_TARGET);
      return;
    }

    let cancelled = false;

    const load = async () => {
      try {
        const query = await invoke<SessionTargetQuery>('get_session_target_query', {
          dbType: connection.db_type
        });
        const rows = await requireDatabase(database).select(query.sql, []);
        if (cancelled) {
          return;
        }
        setTarget(normalizeSessionTarget(Array.isArray(rows) ? rows[0] : undefined));
      } catch (error) {
        if (cancelled) {
          return;
        }
        // 问不出来就退回「未知」：头部改显示连接配置里的库名，
        // 那是我们唯一还能担保的东西。不值得为它弹一条错误。
        console.warn('读取会话目标失败:', error);
        setTarget(UNKNOWN_SESSION_TARGET);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [connection.id, connection.db_type, database]);

  return target;
}
