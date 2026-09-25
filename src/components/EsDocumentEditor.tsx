import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import CodeMirror from '@uiw/react-codemirror';
import { StreamLanguage } from '@codemirror/language';
import { json } from '@codemirror/legacy-modes/mode/javascript';
import { oneDark } from '@codemirror/theme-one-dark';
import { AlertCircle, Loader2, Save, Trash2, X } from 'lucide-react';
import type { ConnectionProfile } from '../contracts/connection';
import { useQueryStore } from '../stores/queryStore';
import { useLanguageStore } from '../stores/languageStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useThemeStore } from '../stores/themeStore';
import { DestructiveStatementPrompt } from './DestructiveStatementPrompt';
import { appEditorTheme } from '../utils/editorTheme';
import { describeError } from '../utils/describeError';
import { parseJson } from '../utils/esJson';
import {
  readDocument,
  readPath,
  sourceProblem,
  writeOutcome,
  writePath,
  type DocumentAddress,
  type LoadedDocument
} from '../utils/esDocument';
import { requiresConfirmation } from '../utils/statementRisk';
import type { TranslationKey } from '../i18n/translate';

interface EsResponse {
  status: number;
  body: string;
}

const OUTCOME_KEYS: Record<'conflict' | 'gone', TranslationKey> = {
  conflict: 'es.doc.conflict',
  gone: 'es.doc.gone'
};

interface EsDocumentEditorProps {
  connection: ConnectionProfile;
  address: DocumentAddress;
  /** 服务端上的这份文档变了（写成了、别处改过、没了）：让发出这份结果的那条搜索再发一次 */
  onWritten: () => void;
  onClose: () => void;
}

/**
 * 一份文档的编辑框：打开时重新读一次（命中里的 `_source` 可能被筛过字段、也可能已经旧了），
 * 保存与删除都带着读到的版本。要发的请求一直写在下面。
 */
export function EsDocumentEditor({ connection, address, onWritten, onClose }: EsDocumentEditorProps) {
  const t = useLanguageStore((state) => state.t);
  const connectionString = useQueryStore((state) => state.connectionString);
  const timeoutMs = useQueryStore((state) => state.queryTimeoutMs);
  const confirmationPolicy = useSettingsStore((state) => state.confirmationPolicy);
  const resolvedTheme = useThemeStore((state) => state.resolved);
  const [loaded, setLoaded] = useState<LoadedDocument | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<'save' | 'delete' | null>(null);
  const extensions = useMemo(() => [StreamLanguage.define(json), appEditorTheme], []);

  const send = (method: string, path: string, body: string | null) => invoke<EsResponse>('elasticsearch_run', {
    connectionString, method, path, body, ndjson: false, timeoutMs
  });

  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await send('GET', readPath(address), null);
      const document = readDocument(parseJson(response.body));
      setLoaded(document);
      setText(document?.sourceText ?? '');
      if (!document) setError(t(response.status === 404 ? 'es.doc.gone' : 'es.doc.unreadable'));
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void load();
    // 换一份文档才重读
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address.index, address.id, address.routing]);

  const write = async (kind: 'save' | 'delete') => {
    if (!loaded) return;
    setBusy(true);
    setError(null);
    try {
      const path = writePath(address, loaded.version);
      const response = await send(kind === 'save' ? 'PUT' : 'DELETE', path, kind === 'save' ? text.trim() : null);
      const outcome = writeOutcome(response.status);
      if (outcome === 'done') {
        onWritten();
        if (kind === 'delete') {
          onClose();
          return;
        }
        await load();
        return;
      }
      // 别处改过、已经没了：服务端上的样子变了，结果也跟着重发一次；编辑框里的字留着，改的内容还能抄走
      if (outcome !== 'failed') onWritten();
      setError(outcome === 'failed' ? `HTTP ${response.status}: ${response.body.slice(0, 500)}` : t(OUTCOME_KEYS[outcome]));
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  };

  const problem = loaded ? sourceProblem(text) : null;
  const unchanged = loaded !== null && text === loaded.sourceText;
  const savePreview = loaded ? `PUT ${writePath(address, loaded.version)}\n${text.trim()}` : '';
  const deletePreview = loaded ? `DELETE ${writePath(address, loaded.version)}` : '';

  const save = () => {
    if (requiresConfirmation('scoped-write', connection.environment, confirmationPolicy)) {
      setAsking('save');
      return;
    }
    void write('save');
  };

  return (
    <div className="flex h-full flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="min-w-0 truncate font-mono text-xs text-fg-muted" title={`${address.index} / ${address.id}`}>
          <span className="font-sans font-medium text-fg">{t('es.doc.title')}</span>
          {`  ${address.index} / ${address.id}`}
          {address.routing !== null && `  (routing ${address.routing})`}
        </p>
        <button type="button" onClick={onClose} aria-label={t('common.close')} className="text-fg-muted hover:text-fg">
          <X size={14} />
        </button>
      </div>
      {loaded && (
        <div className="min-h-0 flex-1 overflow-hidden rounded-control border border-line-strong">
          <CodeMirror
            value={text}
            onChange={setText}
            theme={resolvedTheme === 'dark' ? oneDark : undefined}
            extensions={extensions}
            basicSetup={{ lineNumbers: true, foldGutter: true, autocompletion: false, highlightActiveLine: false }}
            height="100%"
            className="h-full text-sm"
          />
        </div>
      )}
      {busy && !loaded && (
        <p className="flex items-center gap-2 text-sm text-fg-muted">
          <Loader2 size={14} className="animate-spin" />
          {t('es.doc.loading')}
        </p>
      )}
      {problem && <p className="text-xs text-warning">{t(problem === 'invalid' ? 'es.doc.invalid' : 'es.doc.notObject')}</p>}
      {error && (
        <p className="flex items-start gap-1 text-xs text-danger">
          <AlertCircle size={12} className="mt-0.5 shrink-0" />
          <span className="select-text break-all">{error}</span>
        </p>
      )}
      {loaded && (
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate font-mono text-xs text-fg-subtle" title={savePreview}>{`PUT ${writePath(address, loaded.version)}`}</p>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => setAsking('delete')}
              disabled={busy}
              className="flex items-center gap-1 rounded-control border border-danger-line px-3 py-1 text-sm text-danger hover:bg-danger-soft disabled:opacity-50"
            >
              <Trash2 size={13} />
              {t('es.doc.delete')}
            </button>
            <button
              type="button"
              onClick={save}
              disabled={busy || unchanged || problem !== null}
              className="flex items-center gap-1 rounded-control bg-accent px-3 py-1 text-sm text-accent-fg hover:opacity-90 disabled:opacity-50"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              {t('es.doc.save')}
            </button>
          </div>
        </div>
      )}
      {asking && (
        <DestructiveStatementPrompt
          sql={asking === 'save' ? savePreview : deletePreview}
          risk="scoped-write"
          statementCount={1}
          connectionName={connection.name}
          environment={connection.environment}
          databaseLabel="Elasticsearch"
          reversibility={{ kind: 'autocommit' }}
          alwaysAsks={asking === 'delete'}
          impacts={asking === 'delete' ? [t('es.doc.impact', { id: address.id, index: address.index })] : undefined}
          onConfirm={() => {
            const kind = asking;
            setAsking(null);
            void write(kind);
          }}
          onCancel={() => setAsking(null)}
        />
      )}
    </div>
  );
}
