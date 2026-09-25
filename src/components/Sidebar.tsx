import React, { useState, useEffect, useRef } from 'react';
import {
  Plus,
  Database,
  ChevronDown,
  Edit,
  Trash2,
  AlertCircle,
  X,
  SlidersHorizontal,
  History,
  PanelLeftClose
} from 'lucide-react';
import { ConnectionConfig, useConnectionStore } from '../stores/connectionStore';
import DatabaseExplorer from './DatabaseExplorer';
import { ConnectionForm } from './ConnectionForm';
import { ThemeToggle } from './ThemeToggle';
import { LanguageToggle } from './LanguageToggle';
import { SettingsDialog } from './SettingsDialog';
import { EnvironmentBadgeTag } from './EnvironmentBadge';
import { useAppStore } from '../stores/appStore';
import { useConfirmPrompt } from './ConfirmPrompt';
import { useProfileConnector } from '../hooks/useProfileConnector';
import { describeError } from '../utils/describeError';
import { useLanguageStore, translateNow } from '../stores/languageStore';

interface SidebarProps {
  activeConnectionId?: string | null;
  onConnectionDeleted?: (deletedConnectionId: string) => Promise<void>;
  onTableSelect?: (tableName: string, schema?: string) => void;
  onOpenStructure?: (tableName: string, schema?: string) => void;
  onOpenErDiagram?: () => void;
  /** Neo4j 的标签与关系类型点开是一条查询：开一个查询标签并跑一次 */
  onOpenQuery?: (query: string, title: string) => void;
  /** 历史对话框由 App 渲染：它要能把一条语句开进新标签，而建标签是 App 的事 */
  onOpenHistory?: () => void;
  /** 折叠按钮。折叠后侧边栏只剩一条窄轨，展开的入口在 App 那边 */
  onCollapse?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeConnectionId,
  onConnectionDeleted,
  onTableSelect,
  onOpenStructure,
  onOpenErDiagram,
  onOpenQuery,
  onOpenHistory,
  onCollapse
}) => {
  const t = useLanguageStore((state) => state.t);
  const { connections, loadConnections, deleteConnection } = useConnectionStore();
  const { connectionForm, openConnectionForm, closeConnectionForm } = useAppStore();
  const [showConnectionMenu, setShowConnectionMenu] = useState(false);
  const connectionMenuRef = useRef<HTMLDivElement>(null);
  // 只装本组件自己产生的错误（加载列表、删除连接）；连接过程的错误由 connector 持有
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const { ask, prompt: confirmPrompt } = useConfirmPrompt();
  const {
    connect,
    connectingProfileId,
    error: connectError,
    clearError: clearConnectError
  } = useProfileConnector();
  const visibleError = connectError ?? connectionError;

  // 初始化时加载连接列表。
  // 这里用 translateNow 而不是 t：把 t 放进依赖会让每次切换语言都重新拉一遍
  // 连接列表，而这个回调是异步的、之后才触发，取当下的语言本来就更贴切。
  useEffect(() => {
    loadConnections().catch(err => {
      console.error('加载连接列表失败:', err);
      setConnectionError(describeError(err, translateNow('connection.loadListFailed')));
    });
  }, []);

  // 处理新建连接
  const handleCreateConnection = () => {
    setConnectionError(null);
    openConnectionForm();
  };

  // 获取当前连接
  const currentConnection = connections.find(c => c.id === activeConnectionId);

  // 连接流程（含未保存密码时转去输入）由 useProfileConnector 统一持有，
  // 欢迎页的启动面板用的是同一份，不存在两套行为不一致的实现
  const handleConnectionSelect = async (connection: ConnectionConfig) => {
    setConnectionError(null);
    // 失败时保留菜单：错误提示就画在菜单里，一起收起来等于没提示
    if (await connect(connection) !== 'failed') {
      setShowConnectionMenu(false);
    }
  };

  // 下拉菜单盖在对象树上面：点到别处或按 Esc 就收起。此前只能再点一次按钮，
  // 点树上的集合、按 Esc 都关不掉。挂在 mousedown 上，那一下点击照常落到它该去的地方
  useEffect(() => {
    if (!showConnectionMenu) {
      return;
    }
    const closeOutside = (event: MouseEvent) => {
      if (!connectionMenuRef.current?.contains(event.target as Node)) {
        setShowConnectionMenu(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowConnectionMenu(false);
      }
    };
    document.addEventListener('mousedown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [showConnectionMenu]);

  // 处理编辑连接
  const handleEditConnection = (connection: ConnectionConfig) => {
    openConnectionForm(connection);
    setShowConnectionMenu(false);
  };

  // 处理删除连接
  const handleDeleteConnection = async (connection: ConnectionConfig) => {
    // 先收起菜单：确认框画在它上面的话，菜单里那一行还亮着，像是两个框在问同一件事
    setShowConnectionMenu(false);
    const userConfirmed = await ask({
      title: t('connection.deleteConfirmTitle'),
      message: t('connection.deleteConfirm', { name: connection.name }),
      confirmLabel: t('connection.delete'),
      destructive: true
    });
    
    if (userConfirmed) {
      try {
        await deleteConnection(connection.id);
        if (activeConnectionId === connection.id && onConnectionDeleted) {
          await onConnectionDeleted(connection.id);
        }
      } catch (error) {
        console.error('删除连接失败:', error);
        setConnectionError(describeError(error, t('connection.deleteFailed')));
      }
    }
    setShowConnectionMenu(false);
  };

  return (
    <div className="h-full flex flex-col bg-surface border-r border-line">
      {/* 头部 - 连接选择器 */}
      <div className="px-4 py-4 border-b border-line bg-surface-sunken">
        <div className="flex items-center gap-2">
        <div ref={connectionMenuRef} className="relative min-w-0 flex-1">
          <button
            onClick={() => setShowConnectionMenu(!showConnectionMenu)}
            className="flex w-full items-center justify-between rounded-control border border-line bg-surface px-2.5 py-1.5 text-sm transition-colors hover:bg-surface-hover"
          >
            <div className="flex min-w-0 items-center gap-2">
              <Database size={14} className="shrink-0 text-fg-muted" />
              <span className="truncate font-medium text-fg">
                {currentConnection ? currentConnection.name : t('connection.select')}
              </span>
              {currentConnection && (
                <EnvironmentBadgeTag environment={currentConnection.environment} compact />
              )}
            </div>
            <ChevronDown size={14} className="shrink-0 text-fg-muted" />
          </button>

          {/* 连接下拉菜单 */}
          {showConnectionMenu && (
            <div className="absolute top-full left-0 right-0 mt-1 bg-surface rounded-panel shadow-lg border border-line z-50 max-h-64 overflow-y-auto">
              {connections.length === 0 ? (
                <p className="px-3 py-2 text-xs text-fg-subtle">{t('connection.none')}</p>
              ) : (
                connections.map(conn => (
                  <div
                    key={conn.id}
                    className="group flex items-center justify-between px-3 py-2.5 hover:bg-surface-hover cursor-pointer border-b border-line last:border-b-0"
                    onClick={() => handleConnectionSelect(conn)}
                  >
                    <div className="flex items-center space-x-2">
                      <Database size={14} className="text-fg-muted" />
                      <span className="text-sm text-fg">{conn.name}</span>
                      <EnvironmentBadgeTag environment={conn.environment} compact />
                      {connectingProfileId === conn.id && (
                        <span className="text-xs text-accent">{t('connection.connecting')}</span>
                      )}
                      {conn.id === activeConnectionId && (
                        <span className="text-xs text-success font-medium">{t('connection.connected')}</span>
                      )}
                    </div>
                    <div className="flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEditConnection(conn);
                        }}
                        className="p-1 text-fg-muted hover:text-accent rounded-control"
                        title={t('connection.edit')}
                      >
                        <Edit size={14} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteConnection(conn);
                        }}
                        className="p-1 text-fg-muted hover:text-danger rounded-control"
                        title={t('connection.delete')}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))
              )}
              
              {/* 错误只属于整个面板，不属于某一行连接；
                  此前渲染在 connections.map() 内部，会按连接数重复出现，
                  而且被挤在窄列里换行成一个词一行 */}
              {visibleError && (
                <div className="flex items-start gap-2 border-t border-danger-line bg-danger-soft px-3 py-2 text-xs text-danger">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  <span className="min-w-0 flex-1 break-words">{visibleError}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setConnectionError(null);
                      clearConnectError();
                    }}
                    className="shrink-0 text-danger hover:text-danger"
                    title={t('connection.dismissError')}
                  >
                    <X size={14} />
                  </button>
                </div>
              )}

              <div className="border-t border-line">
                <button
                  onClick={() => {
                    setShowConnectionMenu(false);
                    handleCreateConnection();
                  }}
                  className="w-full flex items-center space-x-2 px-3 py-2.5 text-sm text-accent hover:bg-accent-soft transition-colors"
                >
                  <Plus size={14} />
                  <span>{t('connection.new')}</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            aria-label={t('panel.collapseSidebar')}
            title={t('panel.collapseSidebar')}
            className="shrink-0 rounded-control border border-line p-1.5 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
          >
            <PanelLeftClose size={14} />
          </button>
        )}
        </div>
      </div>

      {/* 内容区域 */}
      <div className="flex-1 overflow-hidden">
        {activeConnectionId ? (
          // 显示数据库浏览器
          <DatabaseExplorer
            connectionId={activeConnectionId}
            onTableSelect={onTableSelect}
            onOpenStructure={onOpenStructure}
            onOpenErDiagram={onOpenErDiagram}
            onOpenQuery={onOpenQuery}
          />
        ) : (
          // 右侧启动面板已经在说「选一个连接」，这里不再用 48px 图标加三行
          // 文案重复一遍
          <p className="px-3 py-2 text-xs text-fg-subtle">{t('connection.notConnected')}</p>
        )}
      </div>

      {/* 底栏：应用级外观设置。放这里而不是编辑器工具栏——它管的是整个窗口。 */}
      <div className="space-y-1.5 border-t border-line px-3 py-2">
        <div className="flex items-center justify-between">
          <span className="text-xs text-fg-subtle">{t('app.appearance')}</span>
          <ThemeToggle />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-fg-subtle">{t('app.language')}</span>
          <LanguageToggle />
        </div>
        {onOpenHistory && (
          <button
            type="button"
            onClick={onOpenHistory}
            className="flex w-full items-center gap-2 rounded-control px-1 py-1 text-xs text-fg-subtle hover:bg-surface-hover hover:text-fg"
          >
            <History size={13} />
            {t('history.open')}
          </button>
        )}
        <button
          type="button"
          onClick={() => setShowSettings(true)}
          className="flex w-full items-center gap-2 rounded-control px-1 py-1 text-xs text-fg-subtle hover:bg-surface-hover hover:text-fg"
        >
          <SlidersHorizontal size={13} />
          {t('settings.open')}
        </button>
      </div>

      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {confirmPrompt}

      {/* 连接表单弹窗 */}
      {connectionForm && (
        <ConnectionForm
          connection={connectionForm.mode === 'edit' ? connectionForm.connection : undefined}
          mode={connectionForm.mode}
          onClose={() => {
            closeConnectionForm();
            // 重新加载连接列表
            loadConnections().catch(err => {
              console.error('加载连接列表失败:', err);
              setConnectionError(describeError(err, t('connection.loadListFailed')));
            });
          }}
        />
      )}
    </div>
  );
}; 
