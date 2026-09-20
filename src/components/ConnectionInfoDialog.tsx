import { useEffect } from 'react';
import { X } from 'lucide-react';
import type { ConnectionProfile } from '../contracts';
import type { DatabaseSession } from '../contracts/session';

interface ConnectionInfoDialogProps {
  connection: ConnectionProfile;
  session: DatabaseSession | null;
  onClose: () => void;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-4 py-1.5">
      <span className="w-24 shrink-0 text-sm text-gray-500">{label}</span>
      {/* 标识符用等宽字体并允许换行，方便核对与复制 */}
      <span className="min-w-0 flex-1 font-mono text-sm text-gray-800 break-all select-text">
        {value}
      </span>
    </div>
  );
}

/**
 * 连接详情。
 *
 * 配置 ID 与 Session ID 这类标识符放在这里，而不是常驻在工作台头部：
 * 排查问题时需要它们，日常使用时它们只是噪音。
 */
export function ConnectionInfoDialog({ connection, session, onClose }: ConnectionInfoDialogProps) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      aria-labelledby="connection-info-title"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-w-[calc(100vw-2rem)] bg-white rounded-lg shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
          <h2 id="connection-info-title" className="text-base font-medium text-gray-900">
            连接信息
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="p-1 rounded text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-3 divide-y divide-gray-100">
          <div className="pb-2">
            <Row label="名称" value={connection.name} />
            <Row label="类型" value={connection.db_type} />
            <Row label="地址" value={`${connection.host}:${connection.port}`} />
            <Row label="数据库" value={connection.database || '未指定'} />
            <Row label="用户" value={connection.username || '未指定'} />
          </div>

          <div className="py-2">
            <Row label="环境" value={connection.environment} />
            <Row
              label="TLS"
              value={connection.tls_mode ?? (connection.ssl ? '启用（未指定模式）' : '禁用')}
            />
            <Row label="保存密码" value={connection.save_password ? '是' : '否（每次连接时输入）'} />
          </div>

          <div className="pt-2">
            <Row label="配置 ID" value={connection.id} />
            <Row label="Session" value={session?.id ?? '未建立'} />
          </div>
        </div>
      </div>
    </div>
  );
}
