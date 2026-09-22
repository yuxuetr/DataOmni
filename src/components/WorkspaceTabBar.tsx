import {
  FolderOpen, GitBranch, FileText, History, Pin, Plus, Table, X } from 'lucide-react';
import { clsx } from 'clsx';
import { orderWorkspaceTabs, type WorkspaceTab, type WorkspaceTabKind } from '../contracts/workspace';
import type { ConnectionEnvironment } from '../contracts';
import { EnvironmentBadgeTag } from './EnvironmentBadge';
import { useLanguageStore } from '../stores/languageStore';
import { tabTitle } from '../utils/tabTitle';
import { SHORTCUTS, formatShortcut } from '../utils/shortcuts';

interface WorkspaceTabBarProps {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  /** 当前活跃会话所属的连接，用于标出「绑定的连接未激活」的标签 */
  activeProfileId: string | null;
  /** 有未保存草稿的标签 id，脏点据此显示 */
  unsavedTabIds: ReadonlySet<string>;
  /**
   * 连接 id 到环境的映射。标签自己不存环境——配置改过之后标签上的会过期，
   * 而「这个标签连的是不是生产库」必须是当下的事实。
   */
  environmentByProfileId: Readonly<Record<string, ConnectionEnvironment>>;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onContextMenu: (tabId: string, position: { x: number; y: number }) => void;
  /** 未连接时不传，按钮隐藏 */
  onNewSqlTab?: () => void;
  /** 打开一个 `.sql` 文件到新标签。挨着「新建」放：它做的也是开一个新标签 */
  onOpenSqlFile?: () => void;
  /** 没有可重新打开的标签时不传，按钮隐藏 */
  onReopenClosedTab?: () => void;
  closedTabCount?: number;
}

const TAB_ICONS: Record<WorkspaceTabKind, typeof Table> = {
  sql: FileText,
  'table-data': Table,
  'table-structure': FileText,
  'er-diagram': GitBranch
};

export function WorkspaceTabBar({
  tabs,
  activeTabId,
  activeProfileId,
  unsavedTabIds,
  environmentByProfileId,
  onActivate,
  onClose,
  onContextMenu,
  onNewSqlTab,
  onOpenSqlFile,
  onReopenClosedTab,
  closedTabCount = 0
}: WorkspaceTabBarProps) {
  const t = useLanguageStore((state) => state.t);

  return (
    <div className="flex items-stretch bg-surface-sunken border-b border-line overflow-x-auto">
      {orderWorkspaceTabs(tabs).map((tab) => {
        const Icon = TAB_ICONS[tab.kind];
        const isActive = tab.id === activeTabId;
        // 只有一个活跃会话，绑定到其它连接的标签无法执行，先在标签上说明
        const isDetached = tab.availability === 'profile-deleted'
          || tab.binding.profileId !== activeProfileId;

        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onActivate(tab.id)}
            onContextMenu={(event) => {
              event.preventDefault();
              onActivate(tab.id);
              onContextMenu(tab.id, { x: event.clientX, y: event.clientY });
            }}
            title={
              tab.availability === 'profile-deleted'
                ? t('tab.connectionDeleted', { title: tabTitle(tab, t) })
                : isDetached
                  ? t('tab.connectionInactive', { title: tabTitle(tab, t) })
                  : tabTitle(tab, t)
            }
            className={clsx(
              'group flex items-center gap-2 px-3 py-2 text-sm border-r border-line cursor-pointer select-none whitespace-nowrap',
              isActive
                ? 'bg-surface text-fg border-b-2 border-b-accent'
                : 'text-fg-muted hover:bg-surface-hover',
              isDetached && 'italic text-fg-subtle'
            )}
          >
            {tab.pinned
              ? <Pin size={12} className="shrink-0 text-accent" />
              : <Icon size={14} className="shrink-0" />}
            <span className="max-w-[160px] truncate">{tabTitle(tab, t)}</span>
            {environmentByProfileId[tab.binding.profileId] && (
              <EnvironmentBadgeTag
                environment={environmentByProfileId[tab.binding.profileId]}
                compact
              />
            )}
            {(tab.dirty || unsavedTabIds.has(tab.id)) && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-warning shrink-0"
                title={t('tab.unsaved')}
              />
            )}
            <button
              type="button"
              aria-label={t('tab.close', { title: tabTitle(tab, t) })}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
              className="p-0.5 rounded-control text-fg-subtle opacity-0 group-hover:opacity-100 hover:bg-surface-active hover:text-fg"
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      {onNewSqlTab && (
        <button
          type="button"
          onClick={onNewSqlTab}
          title={t('tab.newQueryTab')}
          aria-label={t('tab.newQueryTab')}
          className="flex items-center px-3 text-fg-muted hover:bg-surface-hover hover:text-fg"
        >
          <Plus size={16} />
        </button>
      )}
      {onOpenSqlFile && (
        <button
          type="button"
          onClick={onOpenSqlFile}
          title={t('tab.openSqlFile')}
          aria-label={t('tab.openSqlFile')}
          className="flex items-center px-3 text-fg-muted hover:bg-surface-hover hover:text-fg"
        >
          <FolderOpen size={16} />
        </button>
      )}
      {onReopenClosedTab && (
        <button
          type="button"
          onClick={onReopenClosedTab}
          title={t('tab.reopenClosedTitle', {
            count: closedTabCount,
            shortcut: formatShortcut(SHORTCUTS.reopenClosedTab)
          })}
          aria-label={t('tab.reopenClosed')}
          className="flex items-center gap-1 px-3 text-fg-muted hover:bg-surface-hover hover:text-fg"
        >
          <History size={16} />
          <span className="text-xs">{closedTabCount}</span>
        </button>
      )}
    </div>
  );
}
