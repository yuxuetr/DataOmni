import { AlertCircle, Trash2 } from 'lucide-react';
import type { WorkspaceTab } from '../contracts/workspace';
import { useLanguageStore } from '../stores/languageStore';

interface OfflineTabViewProps {
  tab: WorkspaceTab;
  /** 绑定连接的名字；连接已删除或尚未加载出来时为 null */
  profileName: string | null;
  /** SQL 标签的草稿内容；没有草稿时为空串 */
  draft: string;
}

// 这里不放「连接」按钮：连接要处理 SESSION_PASSWORD_REQUIRED 的密码提示，
// 那套流程在 Sidebar 里，复刻一份不全的只会更糟。侧边栏本来就常驻可见。

export function OfflineTabView({ tab, profileName, draft }: OfflineTabViewProps) {
  const t = useLanguageStore((state) => state.t);
  const profileDeleted = tab.availability === 'profile-deleted';
  const connectionLabel = profileName ?? t('offline.thisConnection');

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div
        className={
          profileDeleted
            ? 'flex items-start gap-3 px-6 py-4 bg-danger-soft border-b border-danger-line'
            : 'flex items-start gap-3 px-6 py-4 bg-warning-soft border-b border-warning-line'
        }
      >
        {profileDeleted
          ? <Trash2 size={18} className="mt-0.5 shrink-0 text-danger" />
          : <AlertCircle size={18} className="mt-0.5 shrink-0 text-warning" />}

        <div className="min-w-0 flex-1">
          <p className={profileDeleted ? 'text-sm text-danger' : 'text-sm text-warning'}>
            {profileDeleted
              ? t('offline.profileDeleted', { name: connectionLabel })
              : t('offline.profileInactive', { name: connectionLabel })}
          </p>
          <p className={profileDeleted ? 'mt-1 text-xs text-danger' : 'mt-1 text-xs text-warning'}>
            {profileDeleted
              ? t('offline.draftKept')
              : t('offline.draftReadonly')}
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {tab.kind === 'sql'
          ? (
            draft.trim().length > 0
              ? (
                // 只读呈现：用 pre 保留原有换行与缩进，用户可以直接选中复制
                <pre className="whitespace-pre-wrap break-words font-mono text-sm text-fg bg-surface-sunken border border-line rounded-control p-4 select-text">
                  {draft}
                </pre>
              )
              : <p className="text-sm text-fg-muted">{t('offline.emptyDraft')}</p>
          )
          : tab.kind === 'er-diagram'
            ? <p className="text-sm text-fg-muted">{t('offline.erNeedsConnection')}</p>
            : (
              <p className="text-sm text-fg-muted">
                {/* 结构页和数据页是两种标签，离线时要读的东西也不一样，
                    对着一个结构标签说「数据需要连接」是在答非所问 */}
                {t(
                  tab.kind === 'table-structure'
                    ? 'offline.structureNeedsConnection'
                    : 'offline.tableNeedsConnection',
                  {
                    table: tab.object.schema
                      ? `${tab.object.schema}.${tab.object.table}`
                      : tab.object.table
                  }
                )}
              </p>
            )}
      </div>
    </div>
  );
}
