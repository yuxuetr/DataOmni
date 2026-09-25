import React, { useState, useEffect } from 'react';
import { 
  Database, 
  FileText, 
  Eye, 
  EyeOff, 
  TestTube,
  Save,
  X,
  AlertCircle,
  CheckCircle,
  Globe,
  Hash,
  Network,
  Zap,
  Search,
  BarChart3,
  FolderOpen,
  Stethoscope,
  Lock
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import {
  isDatabaseTypeSupported,
  PENDING_FEATURES,
  type PendingFeature
} from '../contracts/databaseSupport';
import type { ConnectionDiagnosis } from '../contracts/connectionDiagnosis';
import {
  diagnosisConclusionKey,
  diagnosisLines,
  diagnosisPassed
} from '../utils/connectionDiagnosis';
import { describeError } from '../utils/describeError';
import {
  createDefaultSshTunnel,
  hasStoredSecret,
  isSshTunnelBlank,
  normalizeSshTunnel,
  sshTunnelProblems,
  supportsSshTunnel
} from '../utils/sshTunnel';
import { isMongoSrv, withMongoSrv } from '../utils/mongoSrv';
import { clsx } from 'clsx';
import { PLAIN_TEXT_INPUT } from './FormControls';
import { 
  ConnectionConfig, 
  DatabaseType, 
  type TlsMode,
  createDefaultConfig, 
  getDefaultPort,
  useConnectionStore 
} from '../stores/connectionStore';
import { useLanguageStore } from '../stores/languageStore';
import { ENVIRONMENTS, ENVIRONMENT_NAME_KEYS } from '../contracts/environment';
import {
  SERVER_PRESETS,
  serverPresetConfig,
  serverPresetOf,
  type ServerPreset
} from '../utils/serverPresets';
import type { ConnectionEnvironment } from '../contracts';
import type { TranslationKey } from '../i18n/translate';

interface ConnectionFormProps {
  connection?: ConnectionConfig;
  onClose: () => void;
  mode: 'create' | 'edit';
}

/** 还没接上的功能的名字，列在「有缺口」说明里 */
const PENDING_FEATURE_KEYS: Record<PendingFeature, TranslationKey> = {
  dataEditing: 'feature.dataEditing',
  transactions: 'feature.transactions',
  explain: 'feature.explain',
  structureEditing: 'feature.structureEditing',
  import: 'feature.import',
  streamingExport: 'feature.streamingExport'
};

/** 存文案键：模块级常量用不了 hook，而分类名要跟着语言走 */
const DATABASE_CATEGORIES = [
  { key: 'form.category.relational', icon: Database },
  { key: 'form.category.nosql', icon: Globe },
  { key: 'form.category.analytics', icon: BarChart3 }
] as const satisfies ReadonlyArray<{ key: TranslationKey; icon: unknown }>;

// 数据库类型配置
const databaseTypes: ReadonlyArray<{
  type: DatabaseType;
  name: string;
  icon: React.ReactNode;
  categoryKey: TranslationKey;
  descriptionKey: TranslationKey;
}> = [
  {
    type: DatabaseType.SQLite,
    name: 'SQLite',
    icon: <FileText size={16} />,
    categoryKey: 'form.category.relational',
    descriptionKey: 'form.db.sqlite.desc'
  },
  {
    type: DatabaseType.MySQL,
    name: 'MySQL',
    icon: <Database size={16} />,
    categoryKey: 'form.category.relational',
    descriptionKey: 'form.db.mysql.desc'
  },
  {
    type: DatabaseType.PostgreSQL,
    name: 'PostgreSQL',
    icon: <Database size={16} />,
    categoryKey: 'form.category.relational',
    descriptionKey: 'form.db.postgresql.desc'
  },
  {
    type: DatabaseType.SqlServer,
    name: 'SQL Server',
    icon: <Database size={16} />,
    categoryKey: 'form.category.relational',
    descriptionKey: 'form.db.sqlserver.desc'
  },
  {
    type: DatabaseType.Oracle,
    name: 'Oracle',
    icon: <Database size={16} />,
    categoryKey: 'form.category.relational',
    descriptionKey: 'form.db.oracle.desc'
  },
  {
    type: DatabaseType.MongoDB,
    name: 'MongoDB',
    icon: <Globe size={16} />,
    categoryKey: 'form.category.nosql',
    descriptionKey: 'form.db.mongodb.desc'
  },
  {
    type: DatabaseType.Redis,
    name: 'Redis',
    icon: <Hash size={16} />,
    categoryKey: 'form.category.nosql',
    descriptionKey: 'form.db.redis.desc'
  },
  {
    type: DatabaseType.Neo4j,
    name: 'Neo4j',
    icon: <Network size={16} />,
    categoryKey: 'form.category.nosql',
    descriptionKey: 'form.db.neo4j.desc'
  },
  {
    type: DatabaseType.DuckDB,
    name: 'DuckDB',
    icon: <Zap size={16} />,
    categoryKey: 'form.category.analytics',
    descriptionKey: 'form.db.duckdb.desc'
  },
  {
    type: DatabaseType.ClickHouse,
    name: 'ClickHouse',
    icon: <BarChart3 size={16} />,
    categoryKey: 'form.category.analytics',
    descriptionKey: 'form.db.clickhouse.desc'
  },
  {
    type: DatabaseType.Elasticsearch,
    name: 'Elasticsearch',
    icon: <Search size={16} />,
    categoryKey: 'form.category.analytics',
    descriptionKey: 'form.db.elasticsearch.desc'
  }
];

export const ConnectionForm: React.FC<ConnectionFormProps> = ({ 
  connection, 
  onClose, 
  mode 
}) => {
  const t = useLanguageStore((state) => state.t);
  const {
    createConnection,
    updateConnection,
    testConnection,
    isLoading,
    error,
    testResult,
    clearTestResult
  } = useConnectionStore();

  // 表单状态
  const [formData, setFormData] = useState<Partial<ConnectionConfig>>(() => {
    if (mode === 'edit' && connection) {
      return { ...connection };
    }
    return createDefaultConfig(DatabaseType.SQLite);
  });

  const [showPassword, setShowPassword] = useState(false);
  // 测试结果是后端返回的一句话，成功与否只能从文案判断；集中在这里判一次，
  // 免得图标、边框、文字颜色各判各的
  // 成败来自结构化的 ok，而不是在文案里找「成功」二字——那在翻译之后必然失效
  const testSucceeded = testResult?.ok ?? false;
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  // 诊断是用户在测试失败之后自己点的：不自动跑，免得每次失败都多两次
  // 网络等待——最常见的失败是密码错，那时诊断只会说「网络没问题」
  const [diagnosis, setDiagnosis] = useState<ConnectionDiagnosis | null>(null);
  const [diagnosisError, setDiagnosisError] = useState<string | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const diagnosisConclusion = diagnosis ? diagnosisConclusionKey(diagnosis) : null;
  /**
   * 测试失败时 store 同时写 `error` 和 `testResult`，而后者就是把前者包进
   * 「连接测试失败: …」里——两条一起画，同一句话在底栏上出现两遍。
   *
   * 按**内容**判断而不是按「有没有 testResult」判断：保存失败时 `error` 换成了
   * 另一句话，而上一次测试的 `testResult` 可能还留在屏幕上，那两条说的不是
   * 一件事，都要显示。
   */
  const errorIsRepeatedByTestResult = Boolean(
    error && testResult && testResult.message.includes(error)
  );

  // 清除测试结果当组件卸载时
  useEffect(() => {
    return () => {
      clearTestResult();
    };
  }, [clearTestResult]);

  // 表单验证
  const validateForm = (): boolean => {
    const errors: Record<string, string> = {};

    if (!formData.name?.trim()) {
      errors.name = t('form.error.name');
    }

    if (formData.db_type !== DatabaseType.SQLite) {
      if (!formData.host?.trim()) {
        errors.host = t('form.error.host');
      }
      // MongoDB 可以不开认证：本机和内网的库大多如此，空着就是不带凭据连
      if (!formData.username?.trim() && formData.db_type !== DatabaseType.MongoDB) {
        errors.username = t('form.error.username');
      }
      // SRV 的端口在 DNS 里，这一格藏起来了
      if (!isMongoSrv(formData) && (!formData.port || formData.port <= 0)) {
        errors.port = t('form.error.port');
      }
    } else {
      if (!formData.database?.trim()) {
        errors.database = t('form.error.sqlitePath');
      }
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // 处理数据库类型变化
  const handleDatabaseTypeChange = (type: DatabaseType) => {
    // 按钮本身已 disabled，这里再挡一次：键盘或将来的调用方绕过按钮时，不会
    // 落进一个保存得下、却永远连不上的配置
    if (!isDatabaseTypeSupported(type)) {
      return;
    }

    const defaultConfig = createDefaultConfig(type);
    setFormData(prev => ({
      ...prev,
      ...defaultConfig,
      // 名称与环境是用户先填的、和类型无关的两项；环境此前会被默认值盖回「开发」，
      // 先选了「生产」再点类型，就悄悄变回了开发环境
      name: prev.name,
      environment: prev.environment ?? defaultConfig.environment
    }));
  };

  const handleServerPresetChange = (preset: ServerPreset) => {
    const presetConfig = serverPresetConfig(preset);
    setFormData(prev => ({
      ...prev,
      ...presetConfig,
      name: prev.name,
      environment: prev.environment ?? presetConfig.environment
    }));
  };

  const selectedPreset = serverPresetOf(formData);

  // 选择数据库文件。选完直接写回路径框，用户仍可手改。
  const handleBrowseDatabaseFile = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [{ name: t('form.sqliteFilter'), extensions: ['db', 'sqlite', 'sqlite3', 'db3'] }]
    });

    if (typeof selected === 'string') {
      setFormData(prev => ({
        ...prev,
        database: selected,
        // 还没起过名字就用文件名，省掉一次输入
        name: prev.name?.trim()
          ? prev.name
          : (selected.split(/[\\/]/).pop() ?? '').replace(/\.(db|sqlite|sqlite3|db3)$/i, '')
      }));
    }
  };

  const tunnel = formData.ssh_tunnel ?? null;
  const srv = isMongoSrv(formData);
  // 一格都没填时不提示：刚勾开就红着一片，读起来像是用户做错了什么
  const tunnelGaps = tunnel && !isSshTunnelBlank(tunnel) ? sshTunnelProblems(tunnel) : [];

  const updateTunnel = (patch: Partial<NonNullable<ConnectionConfig['ssh_tunnel']>>) => {
    setFormData((previous) => ({
      ...previous,
      ssh_tunnel: { ...(previous.ssh_tunnel ?? createDefaultSshTunnel()), ...patch }
    }));
  };

  // 关掉隧道就把整份配置去掉，而不是留一个 enabled: false 的字段。
  // 后端靠 `Option` 判断有没有隧道，留着一份填了一半的配置会让
  // 「关掉了」和「填错了」在存档里长得一样
  const toggleTunnel = (enabled: boolean) => {
    setFormData((previous) => ({
      ...previous,
      ssh_tunnel: enabled ? (previous.ssh_tunnel ?? createDefaultSshTunnel()) : null
    }));
  };

  // 选私钥文件。`~/.ssh` 下的文件在 macOS 的选择器里默认是隐藏的，
  // 所以路径框仍然要能手填——这里只是省一次打字
  const handleBrowsePrivateKey = async () => {
    const selected = await open({ multiple: false, directory: false });
    if (typeof selected === 'string') {
      updateTunnel({ private_key_path: selected });
    }
  };

  // 处理端口变化
  const handlePortChange = (port: string) => {
    const portNumber = parseInt(port, 10);
    setFormData(prev => ({ ...prev, port: isNaN(portNumber) ? 0 : portNumber }));
  };

  /**
   * 交给后端之前收拾一遍隧道配置：去掉两端空格，转发目标留空就不传。
   *
   * 放在提交处而不是每次 onChange：边打字边 trim 会让人打不出中间的空格，
   * 而路径里的空格是合法的。
   */
  const submittableConfig = (): ConnectionConfig => {
    const config = formData as ConnectionConfig;
    if (!config.ssh_tunnel) {
      return config;
    }
    return { ...config, ssh_tunnel: normalizeSshTunnel(config.ssh_tunnel) };
  };

  /**
   * 正在做的是测试还是保存。store 的 `isLoading` 两件事共用一个，只拿它挑文案的话，
   * 按「测试连接」时保存按钮也写着「保存中…」——像是按了一下就存了
   */
  const [pendingAction, setPendingAction] = useState<'test' | 'save' | null>(null);

  // 测试连接
  const handleTestConnection = async () => {
    if (!validateForm()) return;

    // 上一次的诊断说的是上一次那组主机端口，留在屏幕上会被当成这次的结论
    setDiagnosis(null);
    setDiagnosisError(null);

    setPendingAction('test');
    try {
      await testConnection(submittableConfig());
    } catch {
      // 错误已在store中处理
    } finally {
      setPendingAction(null);
    }
  };

  /**
   * 查一遍断在哪一段。
   *
   * 不走 `validateForm`：诊断要回答的恰恰包括「主机填了没有」这类问题，
   * 先用表单校验挡住等于把能回答的问题挡在外面。
   */
  const handleDiagnose = async () => {
    setDiagnosing(true);
    setDiagnosis(null);
    setDiagnosisError(null);

    try {
      const result = await invoke<ConnectionDiagnosis>('diagnose_connection', {
        config: formData
      });
      setDiagnosis(result);
    } catch (cause) {
      setDiagnosisError(describeError(cause, t('diagnosis.failedFallback')));
    } finally {
      setDiagnosing(false);
    }
  };

  // 保存连接
  const handleSave = async () => {
    if (!validateForm()) return;

    setPendingAction('save');
    try {
      if (mode === 'create') {
        await createConnection(
          submittableConfig() as Omit<ConnectionConfig, 'id' | 'created_at' | 'updated_at'>
        );
      } else if (connection) {
        await updateConnection(connection.id, submittableConfig());
      }
      onClose();
    } catch {
      // 错误已在store中处理
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <div className="fixed inset-0 bg-scrim flex items-center justify-center z-50">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-panel bg-surface shadow-xl">
        {/* 标题栏 */}
        <div className="flex shrink-0 items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-base font-semibold text-fg">
            {mode === 'create' ? t('form.title.create') : t('form.title.edit')}
          </h2>
          <button
            onClick={onClose}
            className="text-fg-subtle hover:text-fg-muted transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* 表单内容 */}
        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {/* 基本信息 */}
          <div className="space-y-4">
            <h3 className="text-xs font-semibold tracking-wide text-fg-subtle">{t('form.section.basics')}</h3>
            
            {/* 连接名称 */}
            <div>
              <label className="block text-sm font-medium text-fg mb-1">
                {t('form.name')}
              </label>
              <input
                type="text"
                name="connection-name"
                value={formData.name || ''}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                className={clsx(
                  "w-full px-3 py-2 border rounded-control focus:outline-none focus:ring-2 focus:ring-accent",
                  validationErrors.name ? "border-danger-line" : "border-line-strong"
                )}
                placeholder={t('form.namePlaceholder')}
                {...PLAIN_TEXT_INPUT}
              />
              {validationErrors.name && (
                <p className="text-danger text-sm mt-1">{validationErrors.name}</p>
              )}
            </div>

            {/* 环境。此前表单里没有这一项，每个连接都是「开发环境」：生产标识不会出现，
                设置里按环境分的确认门槛也永远只用到开发那一行 */}
            <div>
              <label htmlFor="connection-environment" className="block text-sm font-medium text-fg mb-1">
                {t('form.environment')}
              </label>
              <select
                id="connection-environment"
                value={formData.environment ?? 'development'}
                onChange={(event) => setFormData((previous) => ({
                  ...previous,
                  environment: event.target.value as ConnectionEnvironment
                }))}
                className="w-full px-3 py-2 border border-line-strong rounded-control focus:outline-none focus:ring-2 focus:ring-accent"
              >
                {ENVIRONMENTS.map((environment) => (
                  <option key={environment} value={environment}>
                    {t(ENVIRONMENT_NAME_KEYS[environment])}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-fg-subtle">{t('form.environmentHint')}</p>
            </div>

            {/* 数据库类型 */}
            <div>
              <label className="block text-sm font-medium text-fg mb-3">
                {t('form.dbType')}
              </label>
              
              <div className="space-y-3">
                {DATABASE_CATEGORIES.map(({ key: categoryKey, icon: CategoryIcon }) => (
                  <div key={categoryKey}>
                    <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-fg-subtle">
                      <CategoryIcon size={12} />
                      {t(categoryKey)}
                    </h4>
                    <div className="grid grid-cols-3 gap-1.5">
                      {databaseTypes
                        .filter((dbType) => dbType.categoryKey === categoryKey)
                        .map((dbType) => {
                          const supported = isDatabaseTypeSupported(dbType.type);
                          // 经快捷入口建的 MySQL / PostgreSQL 连接，高亮的是那个入口
                          const selected = formData.db_type === dbType.type && selectedPreset === null;

                          return (
                            <button
                              key={dbType.type}
                              type="button"
                              disabled={!supported}
                              aria-disabled={!supported}
                              onClick={() => handleDatabaseTypeChange(dbType.type)}
                              title={supported ? t(dbType.descriptionKey) : t('form.unsupportedTitle', { name: dbType.name })}
                              className={clsx(
                                'flex items-center gap-2 rounded-control border px-2.5 py-1.5 text-left transition-colors',
                                !supported && 'cursor-not-allowed border-line bg-surface-sunken text-fg-subtle',
                                supported && selected && 'border-accent bg-accent-soft text-accent',
                                supported && !selected
                                  && 'border-line-strong text-fg hover:bg-surface-hover'
                              )}
                            >
                              <span className="shrink-0">{dbType.icon}</span>
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-1.5">
                                  <span className="truncate text-sm">{dbType.name}</span>
                                  {supported && (PENDING_FEATURES[dbType.type]?.length ?? 0) > 0 && (
                                    <span className="shrink-0 rounded-control border border-warning-line bg-warning-soft px-1 text-[10px] leading-tight text-warning">
                                      {t('form.db.gapsTag')}
                                    </span>
                                  )}
                                </span>
                                {!supported && (
                                  <span className="block text-[11px] leading-tight">{t('form.unsupported')}</span>
                                )}
                              </span>
                            </button>
                          );
                        })}
                      {categoryKey === 'form.category.relational'
                        && (Object.keys(SERVER_PRESETS) as ServerPreset[]).map((preset) => {
                          const spec = SERVER_PRESETS[preset];
                          const protocol = spec.dbType === DatabaseType.MySQL ? 'MySQL' : 'PostgreSQL';
                          const selected = selectedPreset === preset;
                          return (
                            <button
                              key={preset}
                              type="button"
                              onClick={() => handleServerPresetChange(preset)}
                              title={t('form.db.viaProtocol', { protocol })}
                              className={clsx(
                                'flex items-center gap-2 rounded-control border px-2.5 py-1.5 text-left transition-colors',
                                selected
                                  ? 'border-accent bg-accent-soft text-accent'
                                  : 'border-line-strong text-fg hover:bg-surface-hover'
                              )}
                            >
                              <span className="shrink-0"><Database size={16} /></span>
                              <span className="min-w-0 flex-1">
                                <span className="flex items-center gap-1.5">
                                  <span className="truncate text-sm">{spec.name}</span>
                                  {spec.gapsKey && (
                                    <span className="shrink-0 rounded-control border border-warning-line bg-warning-soft px-1 text-[10px] leading-tight text-warning">
                                      {t('form.db.gapsTag')}
                                    </span>
                                  )}
                                </span>
                                <span className="block truncate text-[11px] leading-tight text-fg-subtle">
                                  {t('form.db.viaProtocol', { protocol })}
                                </span>
                              </span>
                            </button>
                          );
                        })}
                    </div>
                  </div>
                ))}
              </div>
              {/* 选中有缺口的服务端时把缺口摆出来：让人先知道，而不是用到那一项才撞上 */}
              {/* 分阶段接入的类型：列出这一版还用不了的功能，清单和按钮的显隐是同一份 */}
              {!selectedPreset && formData.db_type && (PENDING_FEATURES[formData.db_type]?.length ?? 0) > 0 && (
                <p className="mt-2 rounded-control border border-warning-line bg-warning-soft px-3 py-2 text-xs text-warning">
                  {t('form.db.pendingFeatures', {
                    database: databaseTypes.find((entry) => entry.type === formData.db_type)?.name ?? '',
                    features: (PENDING_FEATURES[formData.db_type] ?? [])
                      .map((feature) => t(PENDING_FEATURE_KEYS[feature]))
                      .join(t('common.listSeparator'))
                  })}
                </p>
              )}
              {selectedPreset && SERVER_PRESETS[selectedPreset].gapsKey && (
                <p className="mt-2 rounded-control border border-warning-line bg-warning-soft px-3 py-2 text-xs text-warning">
                  {t(SERVER_PRESETS[selectedPreset].gapsKey)}
                </p>
              )}
            </div>
          </div>

          {/* 连接配置 */}
          <div className="space-y-4">
            <h3 className="text-xs font-semibold tracking-wide text-fg-subtle">{t('form.section.connection')}</h3>
            
            {formData.db_type === DatabaseType.SQLite || formData.db_type === DatabaseType.DuckDB ? (
              /* SQLite/DuckDB 配置 */
              <>
                <div>
                  <label htmlFor="database-file" className="mb-1 block text-sm font-medium text-fg">
                    {t('form.sqliteFile')}
                  </label>
                  {/* 原先这里挂着一个 25 行的蓝底说明框，讲相对路径、应用数据目录、
                      绝对路径和 :memory:。能直接选文件之后，那些话没人需要读。 */}
                  <div className="flex gap-2">
                    <input
                      id="database-file"
                      type="text"
                      name="database"
                      value={formData.database ?? ''}
                      onChange={(e) => setFormData(prev => ({ ...prev, database: e.target.value }))}
                      placeholder={t('form.sqlitePlaceholder')}
                      className={clsx(
                        'min-w-0 flex-1 rounded-control border px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-accent',
                        validationErrors.database ? 'border-danger-line' : 'border-line-strong'
                      )}
                      {...PLAIN_TEXT_INPUT}
                    />
                    <button
                      type="button"
                      onClick={() => void handleBrowseDatabaseFile()}
                      className="flex shrink-0 items-center gap-1.5 rounded-control border border-line-strong px-3 py-2 text-sm text-fg-muted hover:bg-surface-hover"
                    >
                      <FolderOpen size={14} />
                      <span>{t('form.choose')}</span>
                    </button>
                  </div>
                  {validationErrors.database && (
                    <p className="mt-1 text-sm text-danger">{validationErrors.database}</p>
                  )}
                  <p className="mt-1 text-xs text-fg-subtle">
                    {t('form.sqliteMemoryHint')}
                  </p>
                </div>
              </>
            ) : (
              /* 其他数据库配置 */
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div className={clsx(srv && 'col-span-2')}>
                    <label className="block text-sm font-medium text-fg mb-1">
                      {t('form.host')}
                    </label>
                    <input
                      type="text"
                      name="host"
                      value={formData.host || ''}
                      onChange={(e) => setFormData(prev => ({ ...prev, host: e.target.value }))}
                      className={clsx(
                        "w-full px-3 py-2 border rounded-control focus:outline-none focus:ring-2 focus:ring-accent",
                        validationErrors.host ? "border-danger-line" : "border-line-strong"
                      )}
                      placeholder={srv ? 'cluster0.abcde.mongodb.net' : 'localhost'}
                      {...PLAIN_TEXT_INPUT}
                    />
                    {validationErrors.host && (
                      <p className="text-danger text-sm mt-1">{validationErrors.host}</p>
                    )}
                  </div>
                  
                  {!srv && (
                  <div>
                    <label className="block text-sm font-medium text-fg mb-1">
                      {t('form.port')}
                    </label>
                    <input
                      type="number"
                      value={formData.port || ''}
                      onChange={(e) => handlePortChange(e.target.value)}
                      className={clsx(
                        "w-full px-3 py-2 border rounded-control focus:outline-none focus:ring-2 focus:ring-accent",
                        validationErrors.port ? "border-danger-line" : "border-line-strong"
                      )}
                      placeholder={getDefaultPort(formData.db_type!).toString()}
                    />
                    {validationErrors.port && (
                      <p className="text-danger text-sm mt-1">{validationErrors.port}</p>
                    )}
                  </div>
                  )}
                </div>

                {formData.db_type === DatabaseType.MongoDB && (
                  <div>
                    <div className="flex items-start">
                      <input
                        id="mongo-srv"
                        type="checkbox"
                        checked={srv}
                        onChange={(event) => {
                          const enabled = event.target.checked;
                          setFormData((previous) => ({ ...previous, ...withMongoSrv(previous, enabled) }));
                        }}
                        className="mt-0.5 h-4 w-4 rounded-control border-line-strong text-accent focus:ring-accent"
                      />
                      <label htmlFor="mongo-srv" className="ml-2 text-sm text-fg">
                        {t('form.mongoSrv')}
                      </label>
                    </div>
                    {srv && <p className="text-xs text-fg-muted mt-1 ml-6">{t('form.mongoSrvHint')}</p>}
                  </div>
                )}

                {/* 数据库名称 - 某些数据库类型不需要 */}
                {(formData.db_type === DatabaseType.MySQL || 
                  formData.db_type === DatabaseType.PostgreSQL || 
                  formData.db_type === DatabaseType.SqlServer ||
                  formData.db_type === DatabaseType.Oracle ||
                  formData.db_type === DatabaseType.MongoDB ||
                  formData.db_type === DatabaseType.Neo4j ||
                  formData.db_type === DatabaseType.ClickHouse) && (
                  <div>
                    <label className="block text-sm font-medium text-fg mb-1">
                      {/* Oracle 按 Easy Connect 连，这一格填的是服务名，不是库名；
                          MongoDB 的连接不绑库，这一格是用户所在的认证库 */}
                      {formData.db_type === DatabaseType.Oracle
                        ? t('form.oracleService')
                        : formData.db_type === DatabaseType.MongoDB ? t('form.mongoAuthSource') : t('form.database')}
                    </label>
                    <input
                      type="text"
                      name="database-name"
                      value={formData.database || ''}
                      onChange={(e) => setFormData(prev => ({ ...prev, database: e.target.value }))}
                      className="w-full px-3 py-2 border border-line-strong rounded-control focus:outline-none focus:ring-2 focus:ring-accent"
                      placeholder={
                        formData.db_type === DatabaseType.MySQL ? "mysql" :
                        formData.db_type === DatabaseType.PostgreSQL ? "postgres" :
                        formData.db_type === DatabaseType.SqlServer ? "master" :
                        formData.db_type === DatabaseType.Oracle ? "FREEPDB1" :
                        formData.db_type === DatabaseType.MongoDB ? (srv ? "" : "admin") :
                        formData.db_type === DatabaseType.Neo4j ? "neo4j" :
                        formData.db_type === DatabaseType.ClickHouse ? "default" : ""
                      }
                      {...PLAIN_TEXT_INPUT}
                    />
                    {formData.db_type === DatabaseType.Oracle && (
                      <p className="text-xs text-fg-muted mt-1">{t('form.oracleServiceHint')}</p>
                    )}
                    {formData.db_type === DatabaseType.MongoDB && (
                      <p className="text-xs text-fg-muted mt-1">
                        {t(srv ? 'form.mongoAuthSourceSrvHint' : 'form.mongoAuthSourceHint')}
                      </p>
                    )}
                  </div>
                )}

                {/* Redis 数据库编号 */}
                {formData.db_type === DatabaseType.Redis && (
                  <div>
                    <label className="block text-sm font-medium text-fg mb-1">
                      {t('form.redisDb')}
                    </label>
                    <input
                      type="number"
                      value={formData.database || '0'}
                      onChange={(e) => setFormData(prev => ({ ...prev, database: e.target.value }))}
                      className="w-full px-3 py-2 border border-line-strong rounded-control focus:outline-none focus:ring-2 focus:ring-accent"
                      placeholder="0"
                      min="0"
                      max="15"
                    />
                    <p className="text-xs text-fg-muted mt-1">{t('form.redisDbHint')}</p>
                  </div>
                )}

                {/* 用户名密码 - 某些数据库类型不需要用户名 */}
                {(formData.db_type === DatabaseType.MySQL || 
                  formData.db_type === DatabaseType.PostgreSQL || 
                  formData.db_type === DatabaseType.SqlServer ||
                  formData.db_type === DatabaseType.Oracle ||
                  formData.db_type === DatabaseType.MongoDB ||
                  formData.db_type === DatabaseType.Neo4j ||
                  formData.db_type === DatabaseType.ClickHouse ||
                  formData.db_type === DatabaseType.Elasticsearch) && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-fg mb-1">
                        {t('form.username')} {formData.db_type === DatabaseType.Elasticsearch || formData.db_type === DatabaseType.MongoDB ? '' : '*'}
                      </label>
                      <input
                        type="text"
                        name="username"
                        value={formData.username || ''}
                        onChange={(e) => setFormData(prev => ({ ...prev, username: e.target.value }))}
                        className={clsx(
                          "w-full px-3 py-2 border rounded-control focus:outline-none focus:ring-2 focus:ring-accent",
                          validationErrors.username ? "border-danger-line" : "border-line-strong"
                        )}
                        placeholder={t('form.usernamePlaceholder')}
                        {...PLAIN_TEXT_INPUT}
                      />
                      {validationErrors.username && (
                        <p className="text-danger text-sm mt-1">{validationErrors.username}</p>
                      )}
                    </div>
                    
                    <div>
                      <label className="block text-sm font-medium text-fg mb-1">
                        {t('form.password')}
                      </label>
                      <div className="relative">
                        <input
                          type={showPassword ? "text" : "password"}
                          value={formData.password || ''}
                          onChange={(e) => setFormData(prev => ({ ...prev, password: e.target.value }))}
                          className="w-full px-3 py-2 pr-10 border border-line-strong rounded-control focus:outline-none focus:ring-2 focus:ring-accent"
                          placeholder={t('form.passwordPlaceholder')}
                          {...PLAIN_TEXT_INPUT}
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-3 top-1/2 transform -translate-y-1/2 text-fg-subtle hover:text-fg-muted"
                        >
                          {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                        </button>
                      </div>
                    </div>
                    <div className="flex items-start">
                      <input
                        id="save-password"
                        type="checkbox"
                        checked={formData.save_password ?? true}
                        onChange={(event) => setFormData((previous) => ({
                          ...previous,
                          save_password: event.target.checked
                        }))}
                        className="mt-0.5 h-4 w-4 rounded-control border-line-strong text-accent focus:ring-accent"
                      />
                      <label htmlFor="save-password" className="ml-2 text-sm text-fg">
                        {t('form.savePassword')}
                        <span className="block text-xs text-fg-muted">
                          {t('form.savePasswordHint')}
                        </span>
                      </label>
                    </div>
                  </div>
                )}

                {/* SSH 隧道排在 TLS 前面：它决定「怎么够到这台主机」，TLS 决定
                    「够到之后怎么加密」，顺序和实际发生的顺序一致。
                    更要紧的是它此前排在 TLS 证书那一组后面而且默认收起，
                    于是「私钥路径」这个格子在界面上先出现的是 TLS 那一个——
                    实际发生过：SSH 私钥被填进了「客户端私钥路径」，
                    报出来的是一句「客户端证书和私钥必须同时配置」。
                    默认仍然收起：绝大多数连接不需要它，而它有五个格子 */}
                {formData.db_type && supportsSshTunnel(formData.db_type) && !srv && (
                  <div className="space-y-3">
                    <div className="flex items-start">
                      <input
                        id="ssh-tunnel-enabled"
                        type="checkbox"
                        checked={Boolean(tunnel)}
                        onChange={(event) => toggleTunnel(event.target.checked)}
                        className="mt-0.5 h-4 w-4 rounded-control border-line-strong text-accent focus:ring-accent"
                      />
                      <label htmlFor="ssh-tunnel-enabled" className="ml-2 text-sm text-fg">
                        <span className="inline-flex items-center gap-1.5">
                          <Lock size={13} />
                          {t('sshTunnel.enable')}
                        </span>
                        <span className="block text-xs text-fg-muted">
                          {t('sshTunnel.enableHint')}
                        </span>
                      </label>
                    </div>

                    {tunnel && (
                      <div className="space-y-3 rounded-control border border-line bg-surface-sunken p-3">
                        <div className="grid grid-cols-3 gap-3">
                          <div className="col-span-2">
                            <label htmlFor="ssh-host" className="block text-sm font-medium text-fg mb-1">
                              {t('sshTunnel.host')} *
                            </label>
                            <input
                              id="ssh-host"
                              type="text"
                              value={tunnel.host}
                              onChange={(event) => updateTunnel({ host: event.target.value })}
                              placeholder="jump.example.com"
                              className="w-full px-3 py-2 border border-line-strong rounded-control focus:outline-none focus:ring-2 focus:ring-accent"
                              {...PLAIN_TEXT_INPUT}
                            />
                          </div>
                          <div>
                            <label htmlFor="ssh-port" className="block text-sm font-medium text-fg mb-1">
                              {t('sshTunnel.port')}
                            </label>
                            <input
                              id="ssh-port"
                              type="number"
                              value={tunnel.port}
                              onChange={(event) =>
                                updateTunnel({ port: parseInt(event.target.value, 10) || 0 })
                              }
                              placeholder="22"
                              className="w-full px-3 py-2 border border-line-strong rounded-control focus:outline-none focus:ring-2 focus:ring-accent"
                            />
                          </div>
                        </div>

                        <div>
                          <label htmlFor="ssh-username" className="block text-sm font-medium text-fg mb-1">
                            {t('sshTunnel.username')} *
                          </label>
                          <input
                            id="ssh-username"
                            type="text"
                            value={tunnel.username}
                            onChange={(event) => updateTunnel({ username: event.target.value })}
                            placeholder="ops"
                            className="w-full px-3 py-2 border border-line-strong rounded-control focus:outline-none focus:ring-2 focus:ring-accent"
                            {...PLAIN_TEXT_INPUT}
                          />
                        </div>

                        {/* 登录方式决定下面出现哪两格。画成两个单选而不是
                            「私钥路径填了就用私钥」：后者让用口令登录的人
                            对着一个必填的私钥路径不知道填什么 */}
                        <fieldset>
                          <legend className="block text-sm font-medium text-fg mb-1">
                            {t('sshTunnel.auth')}
                          </legend>
                          <div className="flex gap-4">
                            {(['private-key', 'password'] as const).map((method) => (
                              <label key={method} className="flex items-center gap-1.5 text-sm text-fg">
                                <input
                                  type="radio"
                                  name="ssh-auth"
                                  checked={tunnel.auth === method}
                                  onChange={() => updateTunnel({ auth: method })}
                                />
                                {t(method === 'private-key' ? 'sshTunnel.auth.privateKey' : 'sshTunnel.auth.password')}
                              </label>
                            ))}
                          </div>
                        </fieldset>

                        {tunnel.auth === 'private-key' && (
                        <div>
                          <label htmlFor="ssh-private-key" className="block text-sm font-medium text-fg mb-1">
                            {t('sshTunnel.privateKey')} *
                          </label>
                          <div className="flex gap-2">
                            <input
                              id="ssh-private-key"
                              type="text"
                              value={tunnel.private_key_path}
                              onChange={(event) =>
                                updateTunnel({ private_key_path: event.target.value })
                              }
                              placeholder="~/.ssh/id_rsa"
                              className="min-w-0 flex-1 px-3 py-2 border border-line-strong rounded-control focus:outline-none focus:ring-2 focus:ring-accent"
                              {...PLAIN_TEXT_INPUT}
                            />
                            <button
                              type="button"
                              onClick={handleBrowsePrivateKey}
                              className="shrink-0 rounded-control border border-line-strong px-3 py-2 text-sm text-fg transition-colors hover:bg-surface-hover"
                            >
                              {t('form.choose')}
                            </button>
                          </div>
                          <p className="mt-1 text-xs text-fg-muted">
                            {t('sshTunnel.privateKeyHint')}
                          </p>
                        </div>
                        )}

                        {/* 私钥口令与登录口令是同一格：按方式换标签，存的是
                            钥匙串里同一条 `{id}#ssh`——两者不会同时需要 */}
                        <div>
                          <label htmlFor="ssh-secret" className="block text-sm font-medium text-fg mb-1">
                            {t(tunnel.auth === 'private-key' ? 'sshTunnel.passphrase' : 'sshTunnel.password')}
                            {tunnel.auth === 'password' && ' *'}
                          </label>
                          <input
                            id="ssh-secret"
                            type="password"
                            autoComplete="off"
                            value={tunnel.secret}
                            onChange={(event) => updateTunnel({ secret: event.target.value })}
                            className="w-full px-3 py-2 border border-line-strong rounded-control focus:outline-none focus:ring-2 focus:ring-accent"
                            {...PLAIN_TEXT_INPUT}
                          />
                          <p className="mt-1 text-xs text-fg-muted">
                            {hasStoredSecret(tunnel) ? t('sshTunnel.secretStored') : t('sshTunnel.secretHint')}
                          </p>
                        </div>

                        <div className="grid grid-cols-3 gap-3">
                          <div className="col-span-2">
                            <label htmlFor="ssh-remote-host" className="block text-sm font-medium text-fg mb-1">
                              {t('sshTunnel.remoteHost')}
                            </label>
                            <input
                              id="ssh-remote-host"
                              type="text"
                              value={tunnel.remote_host ?? ''}
                              onChange={(event) => updateTunnel({ remote_host: event.target.value })}
                              placeholder={formData.host || '127.0.0.1'}
                              className="w-full px-3 py-2 border border-line-strong rounded-control focus:outline-none focus:ring-2 focus:ring-accent"
                              {...PLAIN_TEXT_INPUT}
                            />
                          </div>
                          <div>
                            <label htmlFor="ssh-remote-port" className="block text-sm font-medium text-fg mb-1">
                              {t('sshTunnel.remotePort')}
                            </label>
                            <input
                              id="ssh-remote-port"
                              type="number"
                              value={tunnel.remote_port ?? ''}
                              onChange={(event) =>
                                updateTunnel({ remote_port: parseInt(event.target.value, 10) || undefined })
                              }
                              placeholder={String(formData.port ?? '')}
                              className="w-full px-3 py-2 border border-line-strong rounded-control focus:outline-none focus:ring-2 focus:ring-accent"
                            />
                          </div>
                        </div>
                        <p className="text-xs text-fg-muted">{t('sshTunnel.remoteHint')}</p>

                        {tunnelGaps.length > 0 && (
                          <p className="text-xs text-danger">
                            {t('sshTunnel.incomplete', {
                              fields: tunnelGaps
                                .map((gap) => t(`sshTunnel.field.${gap}`))
                                .join(t('common.listSeparator'))
                            })}
                          </p>
                        )}

                        <p className="text-xs text-fg-muted">{t('sshTunnel.hostKeyHint')}</p>
                      </div>
                    )}
                  </div>
                )}
                {/* TLS 选项 - 仅对支持 TLS 的数据库显示 */}
                {(formData.db_type === DatabaseType.MySQL || 
                  formData.db_type === DatabaseType.PostgreSQL ||
                  formData.db_type === DatabaseType.SqlServer ||
                  formData.db_type === DatabaseType.MongoDB ||
                  formData.db_type === DatabaseType.Elasticsearch) && (
                  <div className="space-y-4">
                    <div>
                      <label htmlFor="tls-mode" className="block text-sm font-medium text-fg mb-1">
                        {t('form.tlsMode')}
                      </label>
                      <select
                        id="tls-mode"
                        value={formData.tls_mode ?? (formData.ssl ? 'required' : 'disabled')}
                        onChange={(event) => {
                          const tlsMode = event.target.value as TlsMode;
                          setFormData((previous) => ({
                            ...previous,
                            tls_mode: tlsMode,
                            ssl: tlsMode !== 'disabled'
                          }));
                        }}
                        className="w-full px-3 py-2 border border-line-strong rounded-control focus:outline-none focus:ring-2 focus:ring-accent"
                      >
                        <option value="disabled">{t('form.tls.disabled')}</option>
                        <option value="preferred">{t('form.tls.preferred')}</option>
                        <option value="required">{t('form.tls.required')}</option>
                        <option value="verify-ca">{t('form.tls.verifyCa')}</option>
                        <option value="verify-full">{t('form.tls.verifyFull')}</option>
                      </select>
                    </div>

                    {(formData.db_type === DatabaseType.MySQL
                      || formData.db_type === DatabaseType.PostgreSQL
                      || formData.db_type === DatabaseType.SqlServer
                      || formData.db_type === DatabaseType.MongoDB)
                      && (formData.tls_mode ?? (formData.ssl ? 'required' : 'disabled')) !== 'disabled' && (
                      <div className="space-y-3 rounded-control border border-line bg-surface-sunken p-3">
                        {/* 这一组要有自己的标题：里面的「客户端私钥路径」和
                            SSH 隧道那个「私钥文件」只隔着一段，不写清楚归属
                            就会被当成同一个东西 */}
                        <p className="text-xs font-medium text-fg-muted">{t('form.tlsCertificates')}</p>
                        <div>
                          <label htmlFor="ca-certificate" className="block text-sm font-medium text-fg mb-1">
                            {t('form.caPath')}
                          </label>
                          <input
                            id="ca-certificate"
                            type="text"
                            value={formData.ca_certificate_path ?? ''}
                            onChange={(event) => setFormData((previous) => ({
                              ...previous,
                              ca_certificate_path: event.target.value
                            }))}
                            placeholder="/path/to/ca.pem"
                            className="w-full px-3 py-2 border border-line-strong rounded-control focus:outline-none focus:ring-2 focus:ring-accent"
                            {...PLAIN_TEXT_INPUT}
                          />
                        </div>
                        {/* MongoDB 的驱动（和 mongosh 的 --tlsCertificateKeyFile）要证书与私钥
                            在同一个 PEM 文件里，所以只有一格；不替用户拼，那要把私钥另写一份 */}
                        {formData.db_type === DatabaseType.MongoDB && (
                          <div>
                            <label htmlFor="client-certificate" className="block text-sm font-medium text-fg mb-1">
                              {t('form.mongoClientCertPath')}
                            </label>
                            <input
                              id="client-certificate"
                              type="text"
                              value={formData.client_certificate_path ?? ''}
                              onChange={(event) => setFormData((previous) => ({
                                ...previous,
                                client_certificate_path: event.target.value
                              }))}
                              placeholder="/path/to/client.pem"
                              className="w-full px-3 py-2 border border-line-strong rounded-control focus:outline-none focus:ring-2 focus:ring-accent"
                              {...PLAIN_TEXT_INPUT}
                            />
                            <p className="text-xs text-fg-muted mt-1">{t('form.mongoClientCertHint')}</p>
                          </div>
                        )}
                        {/* tiberius 只能校验服务端证书，不带客户端证书登录 */}
                        {formData.db_type !== DatabaseType.SqlServer && formData.db_type !== DatabaseType.MongoDB && (
                        <>
                        <div>
                          <label htmlFor="client-certificate" className="block text-sm font-medium text-fg mb-1">
                            {t('form.clientCertPath')}
                          </label>
                          <input
                            id="client-certificate"
                            type="text"
                            value={formData.client_certificate_path ?? ''}
                            onChange={(event) => setFormData((previous) => ({
                              ...previous,
                              client_certificate_path: event.target.value
                            }))}
                            placeholder="/path/to/client.crt"
                            className="w-full px-3 py-2 border border-line-strong rounded-control focus:outline-none focus:ring-2 focus:ring-accent"
                            {...PLAIN_TEXT_INPUT}
                          />
                        </div>
                        <div>
                          <label htmlFor="client-key" className="block text-sm font-medium text-fg mb-1">
                            {t('form.clientKeyPath')}
                          </label>
                          <input
                            id="client-key"
                            type="text"
                            value={formData.client_key_path ?? ''}
                            onChange={(event) => setFormData((previous) => ({
                              ...previous,
                              client_key_path: event.target.value
                            }))}
                            placeholder="/path/to/client.key"
                            className="w-full px-3 py-2 border border-line-strong rounded-control focus:outline-none focus:ring-2 focus:ring-accent"
                            {...PLAIN_TEXT_INPUT}
                          />
                        </div>
                        </>
                        )}
                      </div>
                    )}
                  </div>
                )}

              </>
            )}
          </div>
        </div>

        {/* 底栏：反馈紧挨着产生它的按钮。整张卡此前一起滚动，点「测试连接」
            要先滚到底，结果却画在顶部，等于看不见。 */}
        <div className="shrink-0 border-t border-line bg-surface-sunken">
          {error && !errorIsRepeatedByTestResult && (
            <div className="flex items-start gap-2 border-b border-danger-line bg-danger-soft px-5 py-2 text-sm text-danger">
              <AlertCircle size={15} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">{error}</span>
            </div>
          )}

          {testResult && (
            <div
              className={clsx(
                'flex items-start gap-2 border-b px-5 py-2 text-sm',
                testSucceeded
                  ? 'border-success-line bg-success-soft text-success'
                  : 'border-danger-line bg-danger-soft text-danger'
              )}
            >
              {testSucceeded
                ? <CheckCircle size={15} className="mt-0.5 shrink-0" />
                : <AlertCircle size={15} className="mt-0.5 shrink-0" />}
              <span className="min-w-0 flex-1 break-words">{testResult.message}</span>
            </div>
          )}

          {diagnosisError && (
            <div className="flex items-start gap-2 border-b border-danger-line bg-danger-soft px-5 py-2 text-sm text-danger">
              <AlertCircle size={15} className="mt-0.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words">
                {t('diagnosis.failed', { reason: diagnosisError })}
              </span>
            </div>
          )}

          {diagnosis && (
            <div className="border-b border-line px-5 py-2 text-sm">
              <h4 className="mb-1 text-xs font-semibold tracking-wide text-fg-subtle">
                {t('diagnosis.title')}
              </h4>
              <ul className="space-y-1">
                {diagnosisLines(diagnosis).map((line, index) => (
                  <li key={`${line.titleKey}-${index}`} className="flex items-start gap-2">
                    {line.ok
                      ? <CheckCircle size={14} className="mt-0.5 shrink-0 text-success" />
                      : <AlertCircle size={14} className="mt-0.5 shrink-0 text-danger" />}
                    <span className="shrink-0 text-fg">{t(line.titleKey)}</span>
                    {/* 事实用等宽字体：这里是地址、路径和系统原话，
                        按比例字体排出来的 IP 很难核对 */}
                    <span className="min-w-0 flex-1 break-all font-mono text-xs text-fg-muted">
                      {line.detail}
                    </span>
                    <span className="shrink-0 text-xs text-fg-subtle">{line.elapsedMs}ms</span>
                  </li>
                ))}
              </ul>
              {/* 结论算不出来时这一段整个不出现，不用一句含糊的话占位 */}
              {diagnosisConclusion && (
                <p
                  className={clsx(
                    'mt-1.5 break-words text-xs',
                    diagnosisPassed(diagnosis) ? 'text-fg-muted' : 'text-danger'
                  )}
                >
                  {t(diagnosisConclusion)}
                </p>
              )}
            </div>
          )}

          <div className="flex items-center justify-between px-5 py-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={isLoading}
                className={clsx(
                  'flex items-center gap-1.5 rounded-control border border-accent px-3 py-1.5 text-sm text-accent transition-colors',
                  isLoading ? 'cursor-not-allowed opacity-50' : 'hover:bg-accent-soft'
                )}
              >
                <TestTube size={14} />
                <span>{pendingAction === 'test' ? t('form.testing') : t('form.testConnection')}</span>
              </button>

              {/* 只在测试失败之后出现：那才是「断在哪一段」这个问题被问出来的
                  时刻。成功时摆一个诊断按钮只会让人怀疑是不是没真的成功 */}
              {/* SRV 没有「主机 + 端口」可探，查 SRV 的那一步驱动已经报得很具体 */}
              {testResult && !testSucceeded && !srv && (
                <button
                  type="button"
                  onClick={handleDiagnose}
                  disabled={diagnosing}
                  className={clsx(
                    'flex items-center gap-1.5 rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg transition-colors',
                    diagnosing ? 'cursor-not-allowed opacity-50' : 'hover:bg-surface-hover'
                  )}
                >
                  <Stethoscope size={14} />
                  <span>{diagnosing ? t('diagnosis.running') : t('diagnosis.run')}</span>
                </button>
              )}
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-control border border-line-strong px-3 py-1.5 text-sm text-fg transition-colors hover:bg-surface-hover"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={isLoading}
                className={clsx(
                  'flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent transition-colors',
                  isLoading ? 'cursor-not-allowed opacity-50' : 'hover:bg-accent-hover'
                )}
              >
                <Save size={14} />
                <span>{pendingAction === 'save' ? t('form.saving') : t('form.saveConnection')}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
