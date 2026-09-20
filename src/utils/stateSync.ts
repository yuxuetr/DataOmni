/**
 * 数据库会话管理工具
 */

import { useAppStore } from '../stores/appStore';
import { selectActiveSqlDocument, useQueryStore } from '../stores/queryStore';
import { useWorkspaceStore } from '../stores/workspaceStore';
import { ConnectionConfig } from '../stores/connectionStore';
import { createDatabaseSession } from '../contracts/session';
import {
  classifyConnectionFailure,
  createConnectionLifecycleState,
  transitionConnectionLifecycle,
  type ConnectionFailureKind,
  type ConnectionLifecycleState
} from '../contracts/connectionLifecycle';

/**
 * 数据库会话管理器
 */
export class SessionManager {
  private static instance: SessionManager;
  private connectionPromises: Map<string, Promise<void>> = new Map();
  private shutdownPromise: Promise<void> | null = null;
  private lifecycle = createConnectionLifecycleState();
  private reconnectTarget: {
    connection: ConnectionConfig;
    connectionString: string;
  } | null = null;

  private constructor() {}

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
  }

  getConnectionState(): ConnectionLifecycleState {
    return this.lifecycle;
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
        error: error instanceof Error ? error.message : String(error)
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

    workspaceStore.handleProfileDeleted(connectionId);

    if (appStore.activeConnection?.config.id === connectionId || ownsRuntimeTarget) {
      await this.disconnect();
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
      await this.disconnect();
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

    // 2. 保存当前SQL历史（如果有活跃连接）
    const activeDocument = selectActiveSqlDocument(queryStore);
    if (queryStore.connectionId && (activeDocument.sqlInput.trim() || activeDocument.statements.length > 0)) {
      console.log('💾 保存当前SQL历史:', queryStore.connectionId);
      queryStore.saveSqlHistory();
    }

    // 3. 断开旧连接
    if (appStore.activeConnection && appStore.activeConnection.config.id !== connection.id) {
      console.log('🔌 断开旧连接:', appStore.activeConnection.config.id);
      await queryStore.disconnect();
      appStore.clearDatabaseMetadata(appStore.activeConnection.config.id);
    }

    // 4. 设置连接中状态
    appStore.setConnectionReady(false);

    // 5. 建立新连接
    await queryStore.connectToDatabase(
      connectionString,
      connection.id,
      createDatabaseSession(connection)
    );

    // 6. 等待数据库连接对象就绪
    await this.waitForDatabaseReady();

    // 7. 设置应用状态
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

    throw new Error('数据库连接对象超时未就绪');
  }

  private transition(
    event: Parameters<typeof transitionConnectionLifecycle>[1]
  ): void {
    this.lifecycle = transitionConnectionLifecycle(this.lifecycle, event);
  }

  private assertCanConnect(): void {
    if (this.shutdownPromise) {
      throw new Error('应用正在关闭，无法建立新的数据库会话');
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
 * 等待连接就绪的工具函数
 */
export async function waitForConnectionReady(timeoutMs: number = 5000): Promise<boolean> {
  const startTime = Date.now();
  const manager = SessionManager.getInstance();

  while (Date.now() - startTime < timeoutMs) {
    const { status } = manager.getConnectionState();
    
    if (status === 'connected') {
      return true;
    }
    
    if (status === 'error' || status === 'offline' || status === 'authentication-expired') {
      return false;
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return false;
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
