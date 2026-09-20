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
  BarChart3
} from 'lucide-react';
import { clsx } from 'clsx';
import { 
  ConnectionConfig, 
  DatabaseType, 
  type TlsMode,
  createDefaultConfig, 
  getDefaultPort,
  useConnectionStore 
} from '../stores/connectionStore';

interface ConnectionFormProps {
  connection?: ConnectionConfig;
  onClose: () => void;
  mode: 'create' | 'edit';
}

// 数据库类型配置
const databaseTypes = [
  {
    type: DatabaseType.SQLite,
    name: 'SQLite',
    icon: <FileText size={16} />,
    category: '关系型数据库',
    description: '轻量级文件数据库'
  },
  {
    type: DatabaseType.MySQL,
    name: 'MySQL',
    icon: <Database size={16} />,
    category: '关系型数据库',
    description: '流行的开源关系型数据库'
  },
  {
    type: DatabaseType.PostgreSQL,
    name: 'PostgreSQL',
    icon: <Database size={16} />,
    category: '关系型数据库',
    description: '功能强大的开源数据库'
  },
  {
    type: DatabaseType.MongoDB,
    name: 'MongoDB',
    icon: <Globe size={16} />,
    category: '非关系型数据库',
    description: '文档型数据库'
  },
  {
    type: DatabaseType.Redis,
    name: 'Redis',
    icon: <Hash size={16} />,
    category: '非关系型数据库',
    description: '内存键值存储'
  },
  {
    type: DatabaseType.Neo4j,
    name: 'Neo4j',
    icon: <Network size={16} />,
    category: '非关系型数据库',
    description: '图数据库'
  },
  {
    type: DatabaseType.DuckDB,
    name: 'DuckDB',
    icon: <Zap size={16} />,
    category: '分析平台',
    description: '嵌入式分析数据库'
  },
  {
    type: DatabaseType.ClickHouse,
    name: 'ClickHouse',
    icon: <BarChart3 size={16} />,
    category: '分析平台',
    description: '列式分析数据库'
  },
  {
    type: DatabaseType.Elasticsearch,
    name: 'Elasticsearch',
    icon: <Search size={16} />,
    category: '分析平台',
    description: '搜索引擎和分析平台'
  }
];

export const ConnectionForm: React.FC<ConnectionFormProps> = ({ 
  connection, 
  onClose, 
  mode 
}) => {
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
      errors.name = '连接名称不能为空';
    }

    if (formData.db_type !== DatabaseType.SQLite) {
      if (!formData.host?.trim()) {
        errors.host = '主机地址不能为空';
      }
      if (!formData.username?.trim()) {
        errors.username = '用户名不能为空';
      }
      if (!formData.port || formData.port <= 0) {
        errors.port = '端口号必须大于0';
      }
    } else {
      if (!formData.database?.trim()) {
        errors.database = 'SQLite 数据库文件路径不能为空';
      }
    }

    setValidationErrors(errors);
    return Object.keys(errors).length === 0;
  };

  // 处理数据库类型变化
  const handleDatabaseTypeChange = (type: DatabaseType) => {
    const defaultConfig = createDefaultConfig(type);
    setFormData(prev => ({
      ...prev,
      ...defaultConfig,
      name: prev.name, // 保留名称
    }));
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
      <div className="bg-surface rounded-panel shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        {/* 标题栏 */}
        <div className="flex items-center justify-between p-6 border-b">
          <h2 className="text-xl font-semibold text-fg">
            {mode === 'create' ? '新建数据库连接' : '编辑数据库连接'}
          </h2>
          <button
            onClick={onClose}
            className="text-fg-subtle hover:text-fg-muted transition-colors"
          >
            <X size={20} />
          </button>
        </div>

        {/* 表单内容 */}
        <div className="p-6 space-y-6">
          {/* 错误提示 */}
          {error && (
            <div className="flex items-center space-x-2 p-3 bg-danger-soft border border-danger-line rounded-control">
              <AlertCircle className="text-danger" size={16} />
              <span className="text-danger text-sm">{error}</span>
            </div>
          )}

          {/* 测试结果 */}
          {testResult && (
            <div className={clsx(
              "flex items-center space-x-2 p-3 border rounded-control",
              testResult.includes('成功') 
                ? "bg-success-soft border-success-line" 
                : "bg-danger-soft border-danger-line"
            )}>
              {testResult.includes('成功') ? (
                <CheckCircle className="text-success" size={16} />
              ) : (
                <AlertCircle className="text-danger" size={16} />
              )}
              <span className={clsx(
                "text-sm",
                testResult.includes('成功') ? "text-success" : "text-danger"
              )}>
                {testResult}
              </span>
            </div>
          )}

          {/* 基本信息 */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-fg">基本信息</h3>
            
            {/* 连接名称 */}
            <div>
              <label className="block text-sm font-medium text-fg mb-1">
                连接名称 *
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
                placeholder="输入连接名称"
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
                数据库类型 *
              </label>
              
              {/* 按分类显示数据库类型 */}
              <div className="space-y-4">
                {/* 关系型数据库 */}
                <div>
                  <h4 className="text-sm font-medium text-fg-muted mb-2 flex items-center">
                    <Database className="w-4 h-4 mr-2" />
                    关系型数据库
                  </h4>
                  <div className="grid grid-cols-3 gap-2">
                    {databaseTypes
                      .filter(db => db.category === '关系型数据库')
                      .map((dbType) => (
                        <button
                          key={dbType.type}
                          type="button"
                          onClick={() => handleDatabaseTypeChange(dbType.type)}
                          className={clsx(
                            "flex flex-col items-center space-y-1 p-3 border rounded-panel transition-all duration-200",
                            formData.db_type === dbType.type
                              ? "border-accent bg-accent-soft text-accent shadow-md"
                              : "border-line-strong hover:border-line-strong hover:bg-surface-sunken"
                          )}
                        >
                          <div className={clsx(
                            "p-2 rounded-control",
                            formData.db_type === dbType.type
                              ? "bg-accent-soft"
                              : "bg-surface-hover"
                          )}>
                            {dbType.icon}
                          </div>
                          <span className="text-sm font-medium">{dbType.name}</span>
                          <span className="text-xs text-fg-muted">{dbType.description}</span>
                        </button>
                      ))}
                  </div>
                </div>

                {/* 非关系型数据库 */}
                <div>
                  <h4 className="text-sm font-medium text-fg-muted mb-2 flex items-center">
                    <Globe className="w-4 h-4 mr-2" />
                    非关系型数据库
                  </h4>
                  <div className="grid grid-cols-3 gap-2">
                    {databaseTypes
                      .filter(db => db.category === '非关系型数据库')
                      .map((dbType) => (
                        <button
                          key={dbType.type}
                          type="button"
                          onClick={() => handleDatabaseTypeChange(dbType.type)}
                          className={clsx(
                            "flex flex-col items-center space-y-1 p-3 border rounded-panel transition-all duration-200",
                            formData.db_type === dbType.type
                              ? "border-accent bg-accent-soft text-accent shadow-md"
                              : "border-line-strong hover:border-line-strong hover:bg-surface-sunken"
                          )}
                        >
                          <div className={clsx(
                            "p-2 rounded-control",
                            formData.db_type === dbType.type
                              ? "bg-accent-soft"
                              : "bg-surface-hover"
                          )}>
                            {dbType.icon}
                          </div>
                          <span className="text-sm font-medium">{dbType.name}</span>
                          <span className="text-xs text-fg-muted">{dbType.description}</span>
                        </button>
                      ))}
                  </div>
                </div>

                {/* 分析平台 */}
                <div>
                  <h4 className="text-sm font-medium text-fg-muted mb-2 flex items-center">
                    <BarChart3 className="w-4 h-4 mr-2" />
                    分析平台
                  </h4>
                  <div className="grid grid-cols-3 gap-2">
                    {databaseTypes
                      .filter(db => db.category === '分析平台')
                      .map((dbType) => (
                        <button
                          key={dbType.type}
                          type="button"
                          onClick={() => handleDatabaseTypeChange(dbType.type)}
                          className={clsx(
                            "flex flex-col items-center space-y-1 p-3 border rounded-panel transition-all duration-200",
                            formData.db_type === dbType.type
                              ? "border-accent bg-accent-soft text-accent shadow-md"
                              : "border-line-strong hover:border-line-strong hover:bg-surface-sunken"
                          )}
                        >
                          <div className={clsx(
                            "p-2 rounded-control",
                            formData.db_type === dbType.type
                              ? "bg-accent-soft"
                              : "bg-surface-hover"
                          )}>
                            {dbType.icon}
                          </div>
                          <span className="text-sm font-medium">{dbType.name}</span>
                          <span className="text-xs text-fg-muted">{dbType.description}</span>
                        </button>
                      ))}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* 连接配置 */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-fg">连接配置</h3>
            
            {formData.db_type === DatabaseType.SQLite || formData.db_type === DatabaseType.DuckDB ? (
              /* SQLite/DuckDB 配置 */
              <>
                <div className="grid grid-cols-4 gap-4 items-center">
                  <label className="text-right text-sm font-medium text-fg">
                    {formData.db_type === DatabaseType.SQLite ? '数据库文件' : '数据库文件'}
                  </label>
                  <div className="col-span-3">
                    <input
                      type="text"
                      name="database"
                      value={formData.database}
                      onChange={(e) => setFormData(prev => ({ ...prev, database: e.target.value }))}
                      placeholder={formData.db_type === DatabaseType.SQLite 
                        ? "例如: mydata.db 或 /完整/路径/到/数据库.db"
                        : "例如: mydata.duckdb 或 /完整/路径/到/数据库.duckdb"
                      }
                      className="w-full px-3 py-2 border border-line-strong rounded-control focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                    {/* 路径帮助说明 */}
                    <div className="mt-2 p-3 bg-accent-soft border border-accent-line rounded-control">
                      <h4 className="text-sm font-medium text-accent mb-2">
                        💡 {formData.db_type === DatabaseType.SQLite ? 'SQLite' : 'DuckDB'}数据库文件路径说明
                      </h4>
                      <div className="text-xs text-accent space-y-1">
                        <div><strong>相对路径:</strong> 输入文件名如 <code className="bg-accent-soft px-1 rounded-control">
                          {formData.db_type === DatabaseType.SQLite ? 'mydata.db' : 'mydata.duckdb'}
                        </code></div>
                        <div className="ml-4 text-accent">→ 将存储在应用数据目录: 
                          <code className="bg-accent-soft px-1 rounded-control">
                            {navigator.platform.toLowerCase().includes('mac') 
                              ? '~/Library/Application Support/dataomni/' 
                              : navigator.platform.toLowerCase().includes('win')
                              ? '%APPDATA%/dataomni/'
                              : '~/.local/share/dataomni/'
                            }[filename]
                          </code>
                        </div>
                        <div><strong>绝对路径:</strong> 输入完整路径如 <code className="bg-accent-soft px-1 rounded-control">
                          /Users/用户名/Documents/{formData.db_type === DatabaseType.SQLite ? 'mydata.db' : 'mydata.duckdb'}
                        </code></div>
                        <div><strong>内存数据库:</strong> 留空或输入 <code className="bg-accent-soft px-1 rounded-control">:memory:</code> (不会持久化)</div>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              /* 其他数据库配置 */
              <>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-fg mb-1">
                      主机地址 *
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
                      端口 *
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
                      数据库名称
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
                      数据库编号
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
                    <p className="text-xs text-fg-muted mt-1">Redis 数据库编号 (0-15)</p>
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
                        用户名 {formData.db_type === DatabaseType.Elasticsearch ? '' : '*'}
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
                        placeholder="输入用户名"
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
                        密码
                      </label>
                      <div className="relative">
                        <input
                          type={showPassword ? "text" : "password"}
                          value={formData.password || ''}
                          onChange={(e) => setFormData(prev => ({ ...prev, password: e.target.value }))}
                          className="w-full px-3 py-2 pr-10 border border-line-strong rounded-control focus:outline-none focus:ring-2 focus:ring-accent"
                          placeholder="输入密码"
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
                        将密码保存到系统凭据库
                        <span className="block text-xs text-fg-muted">
                          关闭后密码仅在本次应用会话中使用，重启后需要重新输入。
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
                        TLS 模式
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
                        <option value="disabled">禁用</option>
                        <option value="preferred">优先使用 TLS</option>
                        <option value="required">要求 TLS</option>
                        <option value="verify-ca">校验证书颁发机构</option>
                        <option value="verify-full">校验证书和主机名</option>
                      </select>
                    </div>

                    {(formData.db_type === DatabaseType.MySQL
                      || formData.db_type === DatabaseType.PostgreSQL)
                      && (formData.tls_mode ?? (formData.ssl ? 'required' : 'disabled')) !== 'disabled' && (
                      <div className="space-y-3 rounded-control border border-line bg-surface-sunken p-3">
                        <div>
                          <label htmlFor="ca-certificate" className="block text-sm font-medium text-fg mb-1">
                            CA 证书路径
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
                            客户端证书路径
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
                            客户端私钥路径
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

        {/* 底部按钮 */}
        <div className="flex items-center justify-between p-6 border-t bg-surface-sunken">
          <button
            onClick={handleTestConnection}
            disabled={isLoading}
            className={clsx(
              "flex items-center space-x-2 px-4 py-2 border border-accent text-accent rounded-control transition-colors",
              isLoading
                ? "opacity-50 cursor-not-allowed"
                : "hover:bg-accent-soft"
            )}
          >
            <TestTube size={16} />
            <span>{isLoading ? '测试中...' : '测试连接'}</span>
          </button>

          <div className="flex space-x-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-fg border border-line-strong rounded-control hover:bg-surface-sunken transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              disabled={isLoading}
              className={clsx(
                "flex items-center space-x-2 px-4 py-2 bg-accent text-fg-on-accent rounded-control transition-colors",
                isLoading
                  ? "opacity-50 cursor-not-allowed"
                  : "hover:bg-accent-hover"
              )}
            >
              <Save size={16} />
              <span>{isLoading ? '保存中...' : '保存连接'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}; 
