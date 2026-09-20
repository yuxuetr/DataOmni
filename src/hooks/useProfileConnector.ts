import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { ConnectionProfile } from '../contracts';
import { DatabaseType } from '../contracts';
import { createDefaultConfig, useConnectionStore } from '../stores/connectionStore';
import { useAppStore } from '../stores/appStore';
import { useSessionManager } from '../utils/stateSync';
import { recordConnectionUse } from '../utils/connectionRecency';

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
      const connectionString = await invoke<string>('test_connection', { config: profile });
      await sessionManager.switchConnection(profile, connectionString);
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
