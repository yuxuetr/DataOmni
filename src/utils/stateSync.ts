/**
 * 数据库会话管理工具
 */

import { useAppStore } from '../stores/appStore';
import { useQueryStore } from '../stores/queryStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { ConnectionConfig } from '../stores/connectionStore';
import { createDatabaseSession } from '../contracts/session';
import {
  classifyConnectionFailure,
  createConnectionLifecycleState,
  transitionConnectionLifecycle,
  type ConnectionFailureKind
} from '../contracts/connectionLifecycle';
import { describeError } from './describeError';
import { translateNow } from '../stores/languageStore';

/**
 * 数据库会话管理器
 */
export class SessionManager {
  private static instance: SessionManager;
  private connectionPromises: Map<string, Promise<void>> = new Map();
  private shutdownPromise: Promise<void> | null = null;
  /**
   * 断线 / 认证过期 / 重连的状态机。**只服务于自动重连**，界面上没有消费者：
   * 界面读的是 `queryStore.connectionLost`，它同时被驱动报的 CONNECTION_LOST
   * 和设备掉网两条路写。
   *
   * 两套表示并存是有意的——这套机器知道「重试了几次」「是认证过期还是网络」，
   * 而界面此刻只需要回答「还能不能用」。什么时候合并：这个字段真的要显示
   * 出来的那天。
   */
  private lifecycle = createConnectionLifecycleState();
  private reconnectTarget: {
    connection: ConnectionConfig;
    connectionString: string;
  } | null = null;

  /**
   * 断开之前问一句：这条连接上还有没有没结束的事务。
   *
   * 由界面注册——只有界面弹得出对话框，而知道「现在要断开」的是这里。
   * 只挂在**用户自己发起**的三条路径上（切换连接、断开、退出应用）：
   * 网络掉线那几条上问也没用，连接已经没了。
   */
  private leaveGuard: (() => Promise<boolean>) | null = null;

  private constructor() {}

  /** 返回 false 表示用户选择留下，调用方必须原地停下 */
  setLeaveGuard(guard: (() => Promise<boolean>) | null): void {
    this.leaveGuard = guard;
  }

  private async mayLeave(): Promise<boolean> {
    return this.leaveGuard ? this.leaveGuard() : true;
  }

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  /**
   * 安全地切换数据库连接
   * @param connection 连接配置
   * @param connectionString 连接字符串
   */
  async switchConnection(connection: ConnectionConfig, connectionString: string): Promise<void> {
    if (!(await this.mayLeave())) {
      return;
    }
    this.assertCanConnect();
    this.reconnectTarget = { connection, connectionString };
    this.transition({
      type: 'connect-requested',
      profileId: connection.id
    });
    await this.connect(connection, connectionString);
  }

  async manualReconnect(connection: ConnectionConfig, connectionString: string): Promise<void> {
    this.assertCanConnect();
    this.reconnectTarget = { connection, connectionString };
    this.transition({
      type: 'manual-reconnect-requested',
      profileId: connection.id
    });
    await this.connect(connection, connectionString);
  }

  async handleNetworkRestored(): Promise<void> {
    this.assertCanConnect();

    if (
      this.lifecycle.status !== 'offline'
      || !this.reconnectTarget
      || this.lifecycle.profileId !== this.reconnectTarget.connection.id
    ) {
      return;
    }

    this.transition({ type: 'network-restored' });
    await this.connect(
      this.reconnectTarget.connection,
      this.reconnectTarget.connectionString
    );
  }

  reportConnectionLost(kind: ConnectionFailureKind, error: string): void {
    const profileId = this.lifecycle.profileId
      ?? useAppStore.getState().activeConnection?.config.id;

    if (!profileId) {
      return;
    }

    this.transition({
      type: 'connection-lost',
      profileId,
      kind,
      error
    });
    useAppStore.getState().setConnectionReady(false);
    // 界面上那个「已连接」标记读的是 queryStore：`connectionReady` 翻成 false
    // 只会让它显示「连接中」，而此刻没有任何连接动作在进行
    useQueryStore.getState().reportConnectionLost();
  }

  private async connect(connection: ConnectionConfig, connectionString: string): Promise<void> {
    const connectionId = connection.id;
    console.log('🔄 SessionManager: 开始切换连接:', connectionId);

    // 如果已经有相同的连接正在进行，等待完成
    if (this.connectionPromises.has(connectionId)) {
      console.log('⏳ 等待现有连接完成:', connectionId);
      await this.connectionPromises.get(connectionId);
      return;
    }

    // 创建连接Promise
    const connectionPromise = this.performConnectionSwitch(connection, connectionString);
    this.connectionPromises.set(connectionId, connectionPromise);

    try {
      await connectionPromise;
      this.transition({ type: 'connected', profileId: connectionId });
      console.log('✅ 连接切换完成:', connectionId);
    } catch (error) {
      this.transition({
        type: 'connection-failed',
        profileId: connectionId,
        kind: classifyConnectionFailure(error),
        error: describeError(error)
      });
      console.error('❌ 连接切换失败:', connectionId, error);
      throw error;
    } finally {
      // 清理Promise
      this.connectionPromises.delete(connectionId);
    }
  }

  /**
   * 关闭当前数据库会话并清理关联的应用状态
   */
  async disconnect(): Promise<void> {
    if (!(await this.mayLeave())) {
      return;
    }
    await this.disconnectNow();
  }

  /**
   * 不问直接断。
   *
   * 连接被删除、网络断开、退出前的收尾走这条：那几处要么已经问过了，
   * 要么根本没得选——连接已经不在了，再问「要不要提交」是在骗人。
   */
  private async disconnectNow(): Promise<void> {
    const appStore = useAppStore.getState();
    const activeConnectionId = appStore.activeConnection?.config.id;

    await useQueryStore.getState().disconnect();

    if (activeConnectionId) {
      appStore.clearDatabaseMetadata(activeConnectionId);
    }

    useAppStore.setState({
      activeConnection: null,
      selectedTable: null,
      connectionReady: false
    });
    useWorkspaceStore.getState().selectSidebarProfile(null);
    this.reconnectTarget = null;
    this.transition({ type: 'disconnected' });
  }

  /**
   * 清理被删除连接关联的运行时状态
   */
  async handleConnectionDeleted(connectionId: string): Promise<void> {
    const appStore = useAppStore.getState();
    const workspaceStore = useWorkspaceStore.getState();
    const ownsRuntimeTarget = this.lifecycle.profileId === connectionId
      || this.reconnectTarget?.connection.id === connectionId;

    // 草稿正文在 queryStore 里，workspaceStore 自己看不到，必须由这里告诉它
    // 哪些标签还有内容，否则带草稿的标签会被一并删掉
    const documents = useQueryStore.getState().documents;
    const tabIdsWithDrafts = new Set(
      Object.entries(documents)
        .filter(([, document]) => document.sqlInput.trim().length > 0)
        .map(([tabId]) => tabId)
    );
    workspaceStore.handleProfileDeleted(connectionId, tabIdsWithDrafts);

    if (appStore.activeConnection?.config.id === connectionId || ownsRuntimeTarget) {
      await this.disconnectNow();
      return;
    }

    appStore.clearDatabaseMetadata(connectionId);
  }

  /**
   * 等待连接任务结束并关闭当前数据库会话
   */
  async shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = this.performShutdown().catch((error) => {
        this.shutdownPromise = null;
        throw error;
      });
    }

    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    await Promise.allSettled(Array.from(this.connectionPromises.values()));

    try {
      await this.disconnectNow();
    } finally {
      this.connectionPromises.clear();
    }
  }

  /**
   * 执行实际的连接切换
   */
  private async performConnectionSwitch(connection: ConnectionConfig, connectionString: string): Promise<void> {
    const appStore = useAppStore.getState();
    const queryStore = useQueryStore.getState();

    // 1. 检查是否需要切换
    if (appStore.activeConnection?.config.id === connection.id && appStore.connectionReady) {
      console.log('✅ 连接已存在且就绪:', connection.id);
      return;
    }

    // 2. 断开旧连接
    //    草稿不再在这里保存：文档按标签存活，由工作区快照整体持久化
    if (appStore.activeConnection && appStore.activeConnection.config.id !== connection.id) {
      console.log('🔌 断开旧连接:', appStore.activeConnection.config.id);
      await queryStore.disconnect();
      appStore.clearDatabaseMetadata(appStore.activeConnection.config.id);
    }

    // 3. 设置连接中状态
    appStore.setConnectionReady(false);

    // 4. 建立新连接
    await queryStore.connectToDatabase(
      connectionString,
      connection.id,
      createDatabaseSession(connection)
    );

    // 5. 等待数据库连接对象就绪
    await this.waitForDatabaseReady();

    // 6. 设置应用状态
    useAppStore.setState({
      activeConnection: { config: connection, connectionString },
      connectionReady: true,
      selectedTable: null
    });
    useWorkspaceStore.getState().selectSidebarProfile(connection.id);

    console.log('✅ 连接状态同步完成:', connection.id);
  }

  /**
   * 等待数据库连接对象就绪
   */
  private async waitForDatabaseReady(maxAttempts: number = 10, delay: number = 100): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      const { database, error } = useQueryStore.getState();
      
      if (error) {
        throw new Error(error);
      }
      
      if (database) {
        console.log('✅ 数据库连接对象就绪');
        return;
      }

      console.log('⏳ 等待数据库连接对象就绪...', i + 1);
      await new Promise(resolve => setTimeout(resolve, delay));
    }

    throw new Error(translateNow('error.connectionNotReady'));
  }

  private transition(
    event: Parameters<typeof transitionConnectionLifecycle>[1]
  ): void {
    this.lifecycle = transitionConnectionLifecycle(this.lifecycle, event);
  }

  private assertCanConnect(): void {
    if (this.shutdownPromise) {
      throw new Error(translateNow('error.appClosing'));
    }
  }

  /**
   * 清理连接状态
   */
  cleanup(): void {
    console.log('🧹 清理连接状态管理器');
    this.connectionPromises.clear();
    this.reconnectTarget = null;
    this.transition({ type: 'disconnected' });
  }
}

/**
 * Hook用于获取连接状态管理器
 */
export function useSessionManager(): SessionManager {
  return SessionManager.getInstance();
}

/**
 * 验证数据库连接对象是否与当前连接ID匹配
 */
export function validateDatabaseConnection(): boolean {
  const appStore = useAppStore.getState();
  const queryStore = useQueryStore.getState();

  // 检查基本状态
  if (!appStore.activeConnection || !queryStore.database || !queryStore.connectionId) {
    console.warn('⚠️ 连接状态不完整');
    return false;
  }

  // 检查连接ID是否匹配
  if (appStore.activeConnection.config.id !== queryStore.connectionId) {
    console.warn('⚠️ 连接ID不匹配', {
      appConnectionId: appStore.activeConnection.config.id,
      queryConnectionId: queryStore.connectionId
    });
    return false;
  }

  // 检查连接是否就绪
  if (!appStore.connectionReady) {
    console.warn('⚠️ 连接未就绪');
    return false;
  }

  return true;
}
