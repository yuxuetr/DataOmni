import { FileText, Plus, Table, X } from 'lucide-react';
import { clsx } from 'clsx';
import type { WorkspaceTab, WorkspaceTabKind } from '../contracts/workspace';

interface WorkspaceTabBarProps {
  tabs: WorkspaceTab[];
  activeTabId: string | null;
  /** 当前活跃会话所属的连接，用于标出「绑定的连接未激活」的标签 */
  activeProfileId: string | null;
  /** 有未保存草稿的标签 id，脏点据此显示 */
  unsavedTabIds: ReadonlySet<string>;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
  /** 未连接时不传，按钮隐藏 */
  onNewSqlTab?: () => void;
}

const TAB_ICONS: Record<WorkspaceTabKind, typeof Table> = {
  sql: FileText,
  'table-data': Table,
  'table-structure': FileText
};

export function WorkspaceTabBar({
  tabs,
  activeTabId,
  activeProfileId,
  unsavedTabIds,
  onActivate,
  onClose,
  onNewSqlTab
}: WorkspaceTabBarProps) {
  return (
    <div className="flex items-stretch bg-gray-50 border-b border-gray-200 overflow-x-auto">
      {tabs.map((tab) => {
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
            title={
              tab.availability === 'profile-deleted'
                ? `${tab.title}（连接已删除，仅可查看草稿）`
                : isDetached
                  ? `${tab.title}（绑定的连接未激活）`
                  : tab.title
            }
            className={clsx(
              'group flex items-center gap-2 px-3 py-2 text-sm border-r border-gray-200 cursor-pointer select-none whitespace-nowrap',
              isActive
                ? 'bg-white text-gray-900 border-b-2 border-b-blue-500'
                : 'text-gray-600 hover:bg-gray-100',
              isDetached && 'italic text-gray-400'
            )}
          >
            <Icon size={14} className="shrink-0" />
            <span className="max-w-[160px] truncate">{tab.title}</span>
            {(tab.dirty || unsavedTabIds.has(tab.id)) && (
              <span
                className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"
                title="有未保存的更改"
              />
            )}
            <button
              type="button"
              aria-label={`关闭 ${tab.title}`}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
              className="p-0.5 rounded text-gray-400 opacity-0 group-hover:opacity-100 hover:bg-gray-200 hover:text-gray-700"
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
          title="新建查询标签"
          aria-label="新建查询标签"
          className="flex items-center px-3 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
        >
          <Plus size={16} />
        </button>
      )}
    </div>
  );
}
