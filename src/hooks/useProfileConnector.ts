import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { ConnectionProfile } from '../contracts';
import { DatabaseType } from '../contracts';
import { createDefaultConfig, useConnectionStore } from '../stores/connectionStore';
import { useAppStore } from '../stores/appStore';
import { useSessionManager } from '../utils/stateSync';
import { recordConnectionUse } from '../utils/connectionRecency';
import { withTimeout } from '../utils/withTimeout';

/**
 * 连接的等待上限。
 *
 * 这不是「多久算慢」，是「多久之后界面必须能恢复」：TCP 通但握手卡住时
 * （防火墙吞包、TLS 协商挂起、服务端不回应）底层 Promise 会一直挂着，
 * connectingProfileId 永不复位，所有连接行保持 disabled——点哪一行都没反应，
 * 也不给任何提示。
 */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * 「选中一个连接并真正连上去」的完整流程。
 *
 * 抽出来是因为它有了第二个调用方（欢迎页的启动面板）。这段流程里唯一不能
 * 省的是 SESSION_PASSWORD_REQUIRED——未保存密码的连接要转去打开表单让用户
 * 输入本次会话密码。在第二处重写一份必然漏掉它，那正是 OfflineTabView 当初
 * 决定不放「连接」按钮的原因。
 */
/**
 * 连接结果。调用方需要区分这三种：
 * 侧边栏的错误提示画在下拉菜单里，失败时必须把菜单留着，否则提示随菜单一起消失。
 */
export type ConnectResult = 'connected' | 'password-required' | 'failed';

export interface ProfileConnector {
  connect: (profile: ConnectionProfile) => Promise<ConnectResult>;
  /** 选一个 SQLite 文件并直接打开；已有指向同一文件的配置时复用它 */
  openSqliteFile: () => Promise<void>;
  /** 正在连接的配置 id，用于在列表行上显示进行中 */
  connectingProfileId: string | null;
  error: string | null;
  clearError: () => void;
}

export function useProfileConnector(): ProfileConnector {
  const sessionManager = useSessionManager();
  const openConnectionForm = useAppStore((state) => state.openConnectionForm);
  const [connectingProfileId, setConnectingProfileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async (profile: ConnectionProfile): Promise<ConnectResult> => {
    setError(null);
    setConnectingProfileId(profile.id);

    try {
      // test_connection 返回带 SSL 参数的连接串，和实际建立会话用的是同一份
      const connectionString = await withTimeout(
        invoke<string>('test_connection', { config: profile }),
        CONNECT_TIMEOUT_MS,
        `连接 ${profile.host || profile.database} 超过 ${CONNECT_TIMEOUT_MS / 1000} 秒没有响应。`
          + '端口可能通但握手未完成，请检查账号密码、TLS 设置与防火墙。'
      );
      await withTimeout(
        sessionManager.switchConnection(profile, connectionString),
        CONNECT_TIMEOUT_MS,
        `建立会话超过 ${CONNECT_TIMEOUT_MS / 1000} 秒没有完成，请重试或检查数据库状态。`
      );
      recordConnectionUse(profile.id);
      return 'connected';
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);

      if (message.includes('SESSION_PASSWORD_REQUIRED')) {
        setError('该连接未保存密码，请输入本次会话密码。');
        openConnectionForm(profile);
        return 'password-required';
      }

      setError(message || '数据库连接失败');
      return 'failed';
    } finally {
      setConnectingProfileId(null);
    }
  }, [sessionManager, openConnectionForm]);

  const openSqliteFile = useCallback(async () => {
    setError(null);

    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: 'SQLite 数据库', extensions: ['db', 'sqlite', 'sqlite3', 'db3'] }]
    });

    if (typeof selected !== 'string') {
      return;
    }

    try {
      const { connections, createConnection, loadConnections } = useConnectionStore.getState();

      // 同一个文件不重复建配置，否则每打开一次列表里就多一条
      const existing = connections.find(
        (profile) => profile.db_type === DatabaseType.SQLite && profile.database === selected
      );

      if (existing) {
        await connect(existing);
        return;
      }

      const fileName = selected.split(/[\\/]/).pop() ?? selected;
      await createConnection({
        ...createDefaultConfig(DatabaseType.SQLite),
        name: fileName.replace(/\.(db|sqlite|sqlite3|db3)$/i, '') || fileName,
        database: selected
      });

      await loadConnections();
      const created = useConnectionStore.getState().connections.find(
        (profile) => profile.db_type === DatabaseType.SQLite && profile.database === selected
      );

      if (!created) {
        setError('连接已创建，但没能在列表中找到它，请从左侧手动选择。');
        return;
      }

      await connect(created);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [connect]);

  return {
    connect,
    openSqliteFile,
    connectingProfileId,
    error,
    clearError: useCallback(() => setError(null), [])
  };
}
