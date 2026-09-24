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
import { describeError } from '../utils/describeError';
import { useLanguageStore } from '../stores/languageStore';

/**
 * 连接的等待上限。
 *
 * 这不是「多久算慢」，是「多久之后界面必须能恢复」：TCP 通但握手卡住时
 * （防火墙吞包、TLS 协商挂起、服务端不回应）底层 Promise 会一直挂着，
 * connectingProfileId 永不复位，所有连接行保持 disabled——点哪一行都没反应，
 * 也不给任何提示。
 *
 * 只套在建立会话那一步上；测试连接那一步为什么不套，见 connect 里的注释。
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
  const t = useLanguageStore((state) => state.t);
  const sessionManager = useSessionManager();
  const openConnectionForm = useAppStore((state) => state.openConnectionForm);
  const [connectingProfileId, setConnectingProfileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async (profile: ConnectionProfile): Promise<ConnectResult> => {
    setError(null);
    setConnectingProfileId(profile.id);

    try {
      // test_connection 返回带 SSL 参数的连接串，和实际建立会话用的是同一份。
      // 这一步**不**加前端超时：它先读钥匙串，换了签名的包第一次读会弹授权框，
      // 用户输密码的时间也被算进去，15 秒一到就报「主机无响应」——主机根本还没碰。
      // 它里面碰网络的几段各自有后端超时（SSH 隧道、SQL Server、Oracle）；
      // MySQL / PostgreSQL / SQLite 在这一步不碰网络，真正的连接在下面。
      const connectionString = await invoke<string>('test_connection', { config: profile });
      await withTimeout(
        sessionManager.switchConnection(profile, connectionString),
        CONNECT_TIMEOUT_MS,
        t('connect.sessionTimeout', { seconds: CONNECT_TIMEOUT_MS / 1000 })
      );
      recordConnectionUse(profile.id);
      return 'connected';
    } catch (cause) {
      const message = describeError(cause);

      if (message.includes('SESSION_PASSWORD_REQUIRED')) {
        setError(t('connect.passwordRequired'));
        openConnectionForm(profile);
        return 'password-required';
      }

      setError(message || t('error.connectFailed'));
      return 'failed';
    } finally {
      setConnectingProfileId(null);
    }
  }, [sessionManager, openConnectionForm, t]);

  const openSqliteFile = useCallback(async () => {
    setError(null);

    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: t('form.sqliteFilter'), extensions: ['db', 'sqlite', 'sqlite3', 'db3'] }]
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
        setError(t('connect.createdButNotFound'));
        return;
      }

      await connect(created);
    } catch (cause) {
      setError(describeError(cause));
    }
  }, [connect, t]);

  return {
    connect,
    openSqliteFile,
    connectingProfileId,
    error,
    clearError: useCallback(() => setError(null), [])
  };
}
