import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowDownToLine, ArrowUpFromLine, CheckCircle2, Database, FileUp, Loader2, Plus, X } from 'lucide-react';
import { clsx } from 'clsx';
import { useConnectionStore } from '../stores/connectionStore';
import { useProfileConnector } from '../hooks/useProfileConnector';
import { orderProfilesByRecency } from '../utils/connectionRecency';
import { serverLabel } from '../utils/serverPresets';
import { connectionTarget } from '../utils/mongoConnection';
import { EnvironmentBadgeTag } from './EnvironmentBadge';
import { useLanguageStore } from '../stores/languageStore';
import { exportConnections, importConnections } from '../utils/connectionTransfer';
import { describeError } from '../utils/describeError';

interface WelcomeScreenProps {
  onConnect: () => void;
}

/**
 * 启动面板。
 *
 * 此前这里是六张功能宣传卡、渐变大标题和三团高斯模糊光斑——对一个每天要开
 * 十几次的窗口来说，那是纯粹的噪音，而且唯一的按钮只会打开新建表单，已有的
 * 连接一个也点不到。现在它做一件事：让人尽快进到某个库里。
 */
export function WelcomeScreen({ onConnect }: WelcomeScreenProps) {
  const t = useLanguageStore((state) => state.t);
  const connections = useConnectionStore((state) => state.connections);
  const loadConnections = useConnectionStore((state) => state.loadConnections);
  const loadError = useConnectionStore((state) => state.loadError);
  const { connect, openDatabaseFile, connectingProfileId, error, clearError } = useProfileConnector();
  // 导入 / 导出的结果就写在这一页上：插件的 message 框在 macOS 打包版里不弹（见 dialogUsage.test.ts）
  const [transfer, setTransfer] = useState<{ failed: boolean; text: string } | null>(null);

  const runTransfer = async (action: () => Promise<string | null>) => {
    try {
      const text = await action();
      if (text) {
        setTransfer({ failed: false, text });
      }
    } catch (cause) {
      setTransfer({ failed: true, text: describeError(cause) });
    }
  };

  useEffect(() => {
    loadConnections().catch((cause) => {
      console.error('加载连接列表失败:', cause);
    });
  }, [loadConnections]);

  // 最近用过的排前面；排序只在列表变化时算一次
  const ordered = useMemo(() => orderProfilesByRecency(connections), [connections]);

  // 连接多了只让列表自己滚：标题和下面两个按钮留在原地。此前整页一起滚，二十来个连接时
  // 「新建连接」被推到窗口外，要先滚到底才看得见。列表不撑满：连接少时框就是那几行高。
  // 外层仍可滚——窗口矮到连两行都放不下时（`min-h`），宁可整页滚也不把列表压没
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="mx-auto flex min-h-0 w-full max-w-lg flex-1 flex-col px-6 pb-10 pt-16">
        <h1 className="shrink-0 text-lg font-semibold text-fg">DataOmni</h1>
        <p className="mt-1 shrink-0 text-xs text-fg-subtle">{t('welcome.hint')}</p>

        {/* 不给关：读不出来时列表是空的，关掉之后就又像是连接全丢了 */}
        {loadError && (
          <div className="mt-4 flex shrink-0 items-start gap-2 rounded-control border border-danger-line bg-danger-soft px-3 py-2 text-xs text-danger">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{loadError}</span>
          </div>
        )}

        {error && (
          <div className="mt-4 flex shrink-0 items-start gap-2 rounded-control border border-danger-line bg-danger-soft px-3 py-2 text-xs text-danger">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <button
              type="button"
              onClick={clearError}
              aria-label={t('connection.dismissError')}
              className="shrink-0 hover:opacity-70"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {transfer && (
          <div
            className={clsx(
              'mt-4 flex shrink-0 items-start gap-2 rounded-control border px-3 py-2 text-xs',
              transfer.failed ? 'border-danger-line bg-danger-soft text-danger' : 'border-accent-line bg-accent-soft text-fg'
            )}
          >
            {transfer.failed
              ? <AlertCircle size={14} className="mt-0.5 shrink-0" />
              : <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-accent" />}
            <span className="min-w-0 flex-1 break-words">{transfer.text}</span>
            <button
              type="button"
              onClick={() => setTransfer(null)}
              aria-label={t('common.close')}
              className="shrink-0 hover:opacity-70"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {ordered.length > 0 && (
          <ul
            className={clsx(
              'mt-5 overflow-y-auto rounded-panel border border-line bg-surface',
              // 约两行半：看得出下面还有、可以滚。不到三个连接时不设，免得框比内容高、空出一截
              ordered.length > 2 && 'min-h-[7.5rem]'
            )}
          >
            {ordered.map((profile) => {
              const isConnecting = connectingProfileId === profile.id;

              return (
                <li key={profile.id} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    onClick={() => void connect(profile)}
                    disabled={connectingProfileId !== null}
                    className={clsx(
                      'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors',
                      'hover:bg-surface-hover disabled:cursor-wait disabled:opacity-60'
                    )}
                  >
                    {isConnecting
                      ? <Loader2 size={15} className="shrink-0 animate-spin text-accent" />
                      : <Database size={15} className="shrink-0 text-fg-subtle" />}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm text-fg">{profile.name}</span>
                        <EnvironmentBadgeTag environment={profile.environment} compact />
                      </span>
                      <span className="block truncate font-mono text-xs text-fg-subtle">
                        {connectionTarget(profile)}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-fg-subtle">{serverLabel(profile)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-4 flex shrink-0 gap-2">
          {/* 不能写成 onClick={onConnect}：React 会把 MouseEvent 当作「要编辑的
              连接」传进去，表单就会以编辑模式打开一个事件对象 */}
          <button
            type="button"
            onClick={() => onConnect()}
            className="flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:bg-accent-hover"
          >
            <Plus size={14} />
            <span>{t('welcome.newConnection')}</span>
          </button>
          <button
            type="button"
            onClick={() => void openDatabaseFile()}
            className="flex items-center gap-1.5 rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg-muted hover:bg-surface-hover"
          >
            <FileUp size={14} />
            <span>{t('welcome.openDatabaseFileEllipsis')}</span>
          </button>
        </div>

        {/* 导入导出不常用，放在下面一行、用文字按钮：和上面两个挤一行时，英文、中文都会折成两行 */}
        <div className="mt-2 flex shrink-0 gap-3 text-xs">
          <button
            type="button"
            onClick={() => void runTransfer(async () => {
              const text = await importConnections();
              if (text) {
                await loadConnections();
              }
              return text;
            })}
            className="flex items-center gap-1 text-fg-subtle hover:text-fg"
          >
            <ArrowDownToLine size={12} />
            <span>{t('welcome.importConnections')}</span>
          </button>
          {ordered.length > 0 && (
            <button
              type="button"
              onClick={() => void runTransfer(exportConnections)}
              className="flex items-center gap-1 text-fg-subtle hover:text-fg"
            >
              <ArrowUpFromLine size={12} />
              <span>{t('welcome.exportConnections')}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
