import { useEffect, useMemo } from 'react';
import { AlertCircle, Database, FileUp, Loader2, Plus, X } from 'lucide-react';
import { clsx } from 'clsx';
import { DatabaseType } from '../contracts';
import { useConnectionStore } from '../stores/connectionStore';
import { useProfileConnector } from '../hooks/useProfileConnector';
import { orderProfilesByRecency } from '../utils/connectionRecency';
import { EnvironmentBadgeTag } from './EnvironmentBadge';

interface WelcomeScreenProps {
  onConnect: () => void;
}

/** 连接行上显示的目标，SQLite 显示文件名，其余显示 host:port/database */
function describeTarget(profile: {
  db_type: DatabaseType;
  host: string;
  port: number;
  database?: string;
}): string {
  if (profile.db_type === DatabaseType.SQLite) {
    return profile.database || ':memory:';
  }

  const target = `${profile.host}:${profile.port}`;
  return profile.database ? `${target}/${profile.database}` : target;
}

/**
 * 启动面板。
 *
 * 此前这里是六张功能宣传卡、渐变大标题和三团高斯模糊光斑——对一个每天要开
 * 十几次的窗口来说，那是纯粹的噪音，而且唯一的按钮只会打开新建表单，已有的
 * 连接一个也点不到。现在它做一件事：让人尽快进到某个库里。
 */
export function WelcomeScreen({ onConnect }: WelcomeScreenProps) {
  const connections = useConnectionStore((state) => state.connections);
  const loadConnections = useConnectionStore((state) => state.loadConnections);
  const { connect, openSqliteFile, connectingProfileId, error, clearError } = useProfileConnector();

  useEffect(() => {
    loadConnections().catch((cause) => {
      console.error('加载连接列表失败:', cause);
    });
  }, [loadConnections]);

  // 最近用过的排前面；排序只在列表变化时算一次
  const ordered = useMemo(() => orderProfilesByRecency(connections), [connections]);

  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto w-full max-w-lg px-6 pb-10 pt-16">
        <h1 className="text-lg font-semibold text-fg">DataOmni</h1>
        <p className="mt-1 text-xs text-fg-subtle">选择一个连接，或新建一个。</p>

        {error && (
          <div className="mt-4 flex items-start gap-2 rounded-control border border-danger-line bg-danger-soft px-3 py-2 text-xs text-danger">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1 break-words">{error}</span>
            <button
              type="button"
              onClick={clearError}
              aria-label="关闭错误提示"
              className="shrink-0 hover:opacity-70"
            >
              <X size={14} />
            </button>
          </div>
        )}

        {ordered.length > 0 && (
          <ul className="mt-5 overflow-hidden rounded-panel border border-line bg-surface">
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
                        {describeTarget(profile)}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-fg-subtle">{profile.db_type}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-4 flex gap-2">
          {/* 不能写成 onClick={onConnect}：React 会把 MouseEvent 当作「要编辑的
              连接」传进去，表单就会以编辑模式打开一个事件对象 */}
          <button
            type="button"
            onClick={() => onConnect()}
            className="flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:bg-accent-hover"
          >
            <Plus size={14} />
            <span>新建连接</span>
          </button>
          <button
            type="button"
            onClick={() => void openSqliteFile()}
            className="flex items-center gap-1.5 rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg-muted hover:bg-surface-hover"
          >
            <FileUp size={14} />
            <span>打开 SQLite 文件…</span>
          </button>
        </div>
      </div>
    </div>
  );
}
