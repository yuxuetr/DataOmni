import { AlertCircle, Trash2 } from 'lucide-react';
import type { WorkspaceTab } from '../contracts/workspace';

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
  const profileDeleted = tab.availability === 'profile-deleted';
  const connectionLabel = profileName ?? '该连接';

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div
        className={
          profileDeleted
            ? 'flex items-start gap-3 px-6 py-4 bg-red-50 border-b border-red-200'
            : 'flex items-start gap-3 px-6 py-4 bg-amber-50 border-b border-amber-200'
        }
      >
        {profileDeleted
          ? <Trash2 size={18} className="mt-0.5 shrink-0 text-red-500" />
          : <AlertCircle size={18} className="mt-0.5 shrink-0 text-amber-500" />}

        <div className="min-w-0 flex-1">
          <p className={profileDeleted ? 'text-sm text-red-800' : 'text-sm text-amber-800'}>
            {profileDeleted
              ? `连接「${connectionLabel}」的配置已被删除，此标签无法再执行查询。`
              : `连接「${connectionLabel}」当前未激活，此标签无法执行查询。`}
          </p>
          <p className={profileDeleted ? 'mt-1 text-xs text-red-700' : 'mt-1 text-xs text-amber-700'}>
            {profileDeleted
              ? '下面是保留下来的草稿，可以选中复制走。'
              : '下面是这个标签的草稿，只读。在左侧重新选择该连接即可继续执行，标签不会改到当前连接上执行。'}
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {tab.kind === 'sql'
          ? (
            draft.trim().length > 0
              ? (
                // 只读呈现：用 pre 保留原有换行与缩进，用户可以直接选中复制
                <pre className="whitespace-pre-wrap break-words font-mono text-sm text-gray-800 bg-gray-50 border border-gray-200 rounded-md p-4 select-text">
                  {draft}
                </pre>
              )
              : <p className="text-sm text-gray-500">这个查询标签还没有写过内容。</p>
          )
          : (
            <p className="text-sm text-gray-500">
              表「{tab.object.schema ? `${tab.object.schema}.${tab.object.table}` : tab.object.table}」
              的数据需要连接后才能读取。
            </p>
          )}
      </div>
    </div>
  );
}
