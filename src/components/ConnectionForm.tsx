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
  FolderOpen
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { isDatabaseTypeSupported } from '../contracts/databaseSupport';
import { clsx } from 'clsx';
import { 
  ConnectionConfig, 
  DatabaseType, 
  type TlsMode,
  createDefaultConfig, 
  getDefaultPort,
  useConnectionStore 
} from '../stores/connectionStore';
import { useLanguageStore } from '../stores/languageStore';
import type { TranslationKey } from '../i18n/translate';

interface ConnectionFormProps {
  connection?: ConnectionConfig;
  onClose: () => void;
  mode: 'create' | 'edit';
}

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
      if (!formData.username?.trim()) {
        errors.username = t('form.error.username');
      }
      if (!formData.port || formData.port <= 0) {
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
      name: prev.name, // 保留名称
    }));
  };

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

  // 处理端口变化
  const handlePortChange = (port: string) => {
    const portNumber = parseInt(port, 10);
    setFormData(prev => ({ ...prev, port: isNaN(portNumber) ? 0 : portNumber }));
  };

  // 测试连接
  const handleTestConnection = async () => {
    if (!validateForm()) return;

    try {
      await testConnection(formData as ConnectionConfig);
    } catch {
      // 错误已在store中处理
    }
  };

  // 保存连接
  const handleSave = async () => {
    if (!validateForm()) return;

    try {
      if (mode === 'create') {
        await createConnection(formData as Omit<ConnectionConfig, 'id' | 'created_at' | 'updated_at'>);
      } else if (connection) {
        await updateConnection(connection.id, formData as ConnectionConfig);
      }
      onClose();
    } catch {
      // 错误已在store中处理
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
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              {validationErrors.name && (
                <p className="text-danger text-sm mt-1">{validationErrors.name}</p>
              )}
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
                          const selected = formData.db_type === dbType.type;

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
                                <span className="block truncate text-sm">{dbType.name}</span>
                                {!supported && (
                                  <span className="block text-[11px] leading-tight">{t('form.unsupported')}</span>
                                )}
                              </span>
                            </button>
                          );
                        })}
                    </div>
                  </div>
                ))}
              </div>
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
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
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
                  <div>
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
                      placeholder="localhost"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                    {validationErrors.host && (
                      <p className="text-danger text-sm mt-1">{validationErrors.host}</p>
                    )}
                  </div>
                  
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
                </div>

                {/* 数据库名称 - 某些数据库类型不需要 */}
                {(formData.db_type === DatabaseType.MySQL || 
                  formData.db_type === DatabaseType.PostgreSQL || 
                  formData.db_type === DatabaseType.MongoDB ||
                  formData.db_type === DatabaseType.Neo4j ||
                  formData.db_type === DatabaseType.ClickHouse) && (
                  <div>
                    <label className="block text-sm font-medium text-fg mb-1">
                      {t('form.database')}
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
                        formData.db_type === DatabaseType.MongoDB ? "admin" :
                        formData.db_type === DatabaseType.Neo4j ? "neo4j" :
                        formData.db_type === DatabaseType.ClickHouse ? "default" : ""
                      }
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                    />
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
                  formData.db_type === DatabaseType.MongoDB ||
                  formData.db_type === DatabaseType.Neo4j ||
                  formData.db_type === DatabaseType.ClickHouse ||
                  formData.db_type === DatabaseType.Elasticsearch) && (
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-sm font-medium text-fg mb-1">
                        {t('form.username')} {formData.db_type === DatabaseType.Elasticsearch ? '' : '*'}
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
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
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

                {/* TLS 选项 - 仅对支持 TLS 的数据库显示 */}
                {(formData.db_type === DatabaseType.MySQL || 
                  formData.db_type === DatabaseType.PostgreSQL ||
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
                      || formData.db_type === DatabaseType.PostgreSQL)
                      && (formData.tls_mode ?? (formData.ssl ? 'required' : 'disabled')) !== 'disabled' && (
                      <div className="space-y-3 rounded-control border border-line bg-surface-sunken p-3">
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
                          />
                        </div>
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
                          />
                        </div>
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
          {error && (
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

          <div className="flex items-center justify-between px-5 py-3">
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
              <span>{isLoading ? t('form.testing') : t('form.testConnection')}</span>
            </button>

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
                <span>{isLoading ? t('form.saving') : t('form.saveConnection')}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
