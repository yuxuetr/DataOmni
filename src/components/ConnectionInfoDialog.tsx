import { useEffect } from 'react';
import { DatabaseType } from '../contracts';
import { X } from 'lucide-react';
import type { ConnectionProfile } from '../contracts';
import type { DatabaseSession } from '../contracts/session';
import { useLanguageStore } from '../stores/languageStore';
import { serverLabel } from '../utils/serverPresets';
import { serverAddress } from '../utils/mongoSrv';

interface ConnectionInfoDialogProps {
  connection: ConnectionProfile;
  session: DatabaseSession | null;
  onClose: () => void;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-4 py-1.5">
      <span className="w-24 shrink-0 text-sm text-fg-muted">{label}</span>
      {/* 标识符用等宽字体并允许换行，方便核对与复制 */}
      <span className="min-w-0 flex-1 font-mono text-sm text-fg break-all select-text">
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
  const t = useLanguageStore((state) => state.t);

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
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim"
      role="dialog"
      aria-modal="true"
      aria-labelledby="connection-info-title"
      onClick={onClose}
    >
      <div
        className="w-[520px] max-w-[calc(100vw-2rem)] bg-surface rounded-panel shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-line">
          <h2 id="connection-info-title" className="text-base font-medium text-fg">
            {t('info.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('info.close')}
            className="p-1 rounded-control text-fg-subtle hover:bg-surface-hover hover:text-fg"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-3 divide-y divide-line">
          <div className="pb-2">
            <Row label={t('info.name')} value={connection.name} />
            <Row label={t('info.type')} value={serverLabel(connection)} />
            {connection.db_type !== DatabaseType.SQLite && (
              <Row label={t('info.address')} value={serverAddress(connection)} />
            )}
            <Row label={t('info.database')} value={connection.database || t('info.unspecified')} />
            <Row label={t('info.user')} value={connection.username || t('info.unspecified')} />
          </div>

          <div className="py-2">
            <Row label={t('info.environment')} value={connection.environment} />
            <Row
              label="TLS"
              value={connection.tls_mode ?? (connection.ssl ? t('info.tlsEnabledUnspecified') : t('info.tlsDisabled'))}
            />
            <Row
          label={t('info.savePassword')}
          value={connection.save_password ? t('info.savePasswordYes') : t('info.savePasswordNo')}
        />
          </div>

          <div className="pt-2">
            <Row label={t('info.profileId')} value={connection.id} />
            <Row label={t('info.session')} value={session?.id ?? t('info.noSession')} />
          </div>
        </div>
      </div>
    </div>
  );
}
