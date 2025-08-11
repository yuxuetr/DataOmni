/**
 * 状态同步工具
 * 用于解决数据库连接切换时的状态管理问题
 */

import { useAppStore } from '../stores/appStore';
import { useQueryStore } from '../stores/queryStore';
import { ConnectionConfig } from '../stores/connectionStore';

/**
 * 数据库连接状态
 */
export enum ConnectionState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting', 
  CONNECTED = 'connected',
  ERROR = 'error'
}

/**
 * 连接状态管理器
 */
export class ConnectionStateManager {
  private static instance: ConnectionStateManager;
  private connectionPromises: Map<string, Promise<void>> = new Map();

  private constructor() {}

  static getInstance(): ConnectionStateManager {
    if (!ConnectionStateManager.instance) {
      ConnectionStateManager.instance = new ConnectionStateManager();
    }
    return ConnectionStateManager.instance;
  }

  /**
   * 安全地切换数据库连接
   * @param connection 连接配置
   * @param connectionString 连接字符串
   */
  async switchConnection(connection: ConnectionConfig, connectionString: string): Promise<void> {
    const connectionId = connection.id;
    console.log('🔄 ConnectionStateManager: 开始切换连接:', connectionId);

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
      console.log('✅ 连接切换完成:', connectionId);
    } catch (error) {
      console.error('❌ 连接切换失败:', connectionId, error);
      throw error;
    } finally {
      // 清理Promise
      this.connectionPromises.delete(connectionId);
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
    if (queryStore.connectionId && (queryStore.sqlInput.trim() || queryStore.statements.length > 0)) {
      console.log('💾 保存当前SQL历史:', queryStore.connectionId);
      queryStore.saveSqlHistory();
    }

    // 3. 断开旧连接
    if (appStore.activeConnection && appStore.activeConnection.config.id !== connection.id) {
      console.log('🔌 断开旧连接:', appStore.activeConnection.config.id);
      queryStore.disconnect();
      appStore.clearDatabaseMetadata(appStore.activeConnection.config.id);
    }

    // 4. 设置连接中状态
    appStore.setConnectionReady(false);

    // 5. 建立新连接
    await queryStore.connectToDatabase(connectionString, connection.id);

    // 6. 等待数据库连接对象就绪
    await this.waitForDatabaseReady();

    // 7. 设置应用状态
    useAppStore.setState({
      activeConnection: { config: connection, connectionString },
      connectionReady: true,
      selectedTable: null
    });

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

  /**
   * 获取当前连接状态
   */
  getConnectionState(): ConnectionState {
    const appStore = useAppStore.getState();
    const queryStore = useQueryStore.getState();

    if (queryStore.isConnecting) {
      return ConnectionState.CONNECTING;
    }

    if (queryStore.error) {
      return ConnectionState.ERROR;
    }

    if (appStore.activeConnection && appStore.connectionReady && queryStore.database) {
      return ConnectionState.CONNECTED;
    }

    return ConnectionState.DISCONNECTED;
  }

  /**
   * 清理连接状态
   */
  cleanup(): void {
    console.log('🧹 清理连接状态管理器');
    this.connectionPromises.clear();
  }
}

/**
 * Hook用于获取连接状态管理器
 */
export function useConnectionStateManager(): ConnectionStateManager {
  return ConnectionStateManager.getInstance();
}

/**
 * 等待连接就绪的工具函数
 */
export async function waitForConnectionReady(timeoutMs: number = 5000): Promise<boolean> {
  const startTime = Date.now();
  const manager = ConnectionStateManager.getInstance();

  while (Date.now() - startTime < timeoutMs) {
    const state = manager.getConnectionState();
    
    if (state === ConnectionState.CONNECTED) {
      return true;
    }
    
    if (state === ConnectionState.ERROR) {
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
