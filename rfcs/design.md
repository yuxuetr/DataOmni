# DataOmni 数据库连接工具设计文档

> **这是 2025-06 的立项设计，写在实现之前，此后没有跟着代码走。**
>
> 它记录的是当初的需求分析与架构意图，可以当立项记录读；**不要当作当前系统的
> 描述**。实现走到哪里、为什么这么选、哪些明确不做，以 `TODOs.md` 为准；
> 对外能力说明以 `README.md` 为准。
>
> 已知与现状不符的地方：§6 API 设计（已移除，见该节）、§12 分析型数据库
> （DuckDB / ClickHouse 在 `TODOs.md` 里仍是「评估并接入」，尚未动工）、
> §15 项目里程碑（已由 P0–P5 取代）。

## 1. 项目概述

DataOmni 是一个基于 Tauri 架构的跨平台数据库连接工具，支持多种主流数据库的连接、管理和操作。采用 React + TailwindCSS 4 + Zustand 构建前端界面，Rust 构建后端核心功能。

## 2. 需求分析

### 2.1 功能性需求

#### 2.1.1 数据库连接管理

- 支持创建、编辑、删除数据库连接配置
- 支持连接测试和状态监控
- 支持连接分组和标记
- 支持导入/导出连接配置

#### 2.1.2 数据库类型支持

##### **关系型数据库 (OLTP)**

- MySQL/MariaDB
- PostgreSQL
- SQLite
- SQL Server
- Oracle (通过ODBC)

##### **分析型数据库 (OLAP)**

- **DuckDB** - 高性能嵌入式分析数据库，支持SQL和列式存储
- **ClickHouse** - 高性能列式数据库，优化大数据分析
- **Apache Drill** - 无模式SQL查询引擎，支持多种数据源
- **QuestDB** - 专业时序数据库，高性能时间序列分析

##### **非关系型数据库**

- MongoDB - 文档型数据库
- Redis - 内存键值存储
- Elasticsearch - 搜索引擎和分析数据库
- **InfluxDB** - 专业时序数据库
- **TimescaleDB** - PostgreSQL扩展的时序数据库

##### **图数据库**

- Neo4j - 专业图数据库
- **ArangoDB** - 多模型数据库（图、文档、键值）

##### **云数据库**

- **BigQuery** - Google云端数据仓库
- **Snowflake** - 云端数据仓库
- **Databricks** - 统一分析平台
- **Amazon Redshift** - AWS数据仓库

#### 2.1.3 数据库操作功能

- 数据库结构浏览（库、表、字段）
- SQL/NoSQL 查询执行
- 数据的增删改查
- 索引管理
- 用户权限管理
- 数据导入/导出
- 性能监控

#### 2.1.4 文档管理功能

- 连接配置文档化
- 数据库结构文档生成
- 查询历史记录
- 操作日志记录
- 团队协作文档共享

### 2.2 非功能性需求

#### 2.2.1 性能要求

- 连接响应时间 < 3秒
- 查询结果展示 < 5秒
- 支持大数据量分页加载
- 内存占用优化

#### 2.2.2 安全要求

- 连接密码加密存储
- SSL/TLS 连接支持
- 操作权限控制
- 审计日志记录

#### 2.2.3 可用性要求

- 跨平台支持（Windows、macOS、Linux）
- 响应式界面设计
- 快捷键操作支持
- 多语言支持

## 3. 技术架构设计

### 3.1 整体架构

```bash
┌─────────────────────────────────────────────────────────┐
│                    Frontend (React)                     │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │
│  │  UI Layer   │  │ State Mgmt  │  │  Service    │      │
│  │ (Components)│  │ (Zustand)   │  │   Layer     │      │
│  └─────────────┘  └─────────────┘  └─────────────┘      │
├─────────────────────────────────────────────────────────┤
│                 Tauri Bridge (IPC)                      │
├─────────────────────────────────────────────────────────┤
│                    Backend (Rust)                       │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐      │
│  │   API       │  │  Business   │  │  Database   │      │
│  │  Handler    │  │   Logic     │  │  Adapters   │      │
│  └─────────────┘  └─────────────┘  └─────────────┘      │
├─────────────────────────────────────────────────────────┤
│                  Database Drivers                       │
└─────────────────────────────────────────────────────────┘
```

### 3.2 前端架构

#### 3.2.1 目录结构

```bash
src/
├── components/          # 可复用组件
│   ├── common/          # 通用组件
│   ├── database/        # 数据库相关组件
│   └── forms/           # 表单组件
├── pages/               # 页面组件
│   ├── connections/     # 连接管理页面
│   ├── explorer/        # 数据库浏览页面
│   └── documents/       # 文档管理页面
├── stores/              # Zustand 状态管理
│   ├── connectionStore.ts
│   ├── databaseStore.ts
│   └── documentStore.ts
├── services/            # API 服务层
│   ├── connectionService.ts
│   ├── databaseService.ts
│   └── documentService.ts
├── types/               # TypeScript 类型定义
├── utils/               # 工具函数
└── hooks/               # 自定义 React Hooks
```

#### 3.2.2 状态管理设计

```typescript
// connectionStore.ts
interface ConnectionStore {
  connections: DatabaseConnection[];
  activeConnection: DatabaseConnection | null;
  connectionStatus: Map<string, 'connected' | 'disconnected' | 'connecting'>;
  
  // Actions
  addConnection: (connection: DatabaseConnection) => void;
  updateConnection: (id: string, connection: Partial<DatabaseConnection>) => void;
  deleteConnection: (id: string) => void;
  setActiveConnection: (connection: DatabaseConnection) => void;
  testConnection: (connection: DatabaseConnection) => Promise<boolean>;
}
```

### 3.3 后端架构

#### 3.3.1 模块设计

```bash
// 主要模块结构
src/
├── commands/             # Tauri 命令处理
│   ├── connection.rs     # 连接管理命令
│   ├── database.rs       # 数据库操作命令
│   └── document.rs       # 文档管理命令
├── database/             # 数据库适配器
│   ├── mod.rs            # 数据库抽象接口
│   ├── relational/       # 关系型数据库适配器
│   ├── analytical/       # 分析型数据库适配器
│   │   ├── duckdb.rs     # DuckDB适配器
│   │   ├── clickhouse.rs # ClickHouse适配器
│   │   └── questdb.rs    # QuestDB适配器
│   ├── nosql/            # 非关系型数据库适配器
│   └── graph/            # 图数据库适配器
├── models/               # 数据模型
├── services/             # 业务逻辑服务
├── utils/                # 工具函数
└── config/               # 配置管理
```

#### 3.3.2 数据库适配器设计

```rust
// 数据库抽象接口
pub trait DatabaseAdapter {
    async fn connect(&self, config: &ConnectionConfig) -> Result<Box<dyn DatabaseConnection>>;
    async fn test_connection(&self, config: &ConnectionConfig) -> Result<bool>;
    fn get_database_type(&self) -> DatabaseType;
}

// 数据库连接接口
pub trait DatabaseConnection: Send + Sync {
    async fn execute_query(&self, query: &str) -> Result<QueryResult>;
    async fn get_databases(&self) -> Result<Vec<String>>;
    async fn get_tables(&self, database: &str) -> Result<Vec<TableInfo>>;
    async fn get_table_schema(&self, database: &str, table: &str) -> Result<TableSchema>;
}
```

#### 3.3.3 分析型数据库支持策略

##### **DuckDB 集成方案**

```rust
// DuckDB 适配器实现
pub struct DuckDBAdapter;

impl DatabaseAdapter for DuckDBAdapter {
    async fn connect(&self, config: &ConnectionConfig) -> Result<Box<dyn DatabaseConnection>> {
        // DuckDB 可以连接文件或内存数据库
        let conn = duckdb::Connection::open(&config.database.unwrap_or(":memory:".to_string()))?;
        Ok(Box::new(DuckDBConnection::new(conn)))
    }
}

// DuckDB 特性支持
// - 嵌入式部署，无需服务器
// - 支持Parquet、CSV、JSON等多种格式
// - 高性能列式存储和向量化查询
// - 完整SQL支持，兼容PostgreSQL语法
```

##### **ClickHouse 集成方案**

```rust
// ClickHouse 适配器实现  
pub struct ClickHouseAdapter;

impl DatabaseAdapter for ClickHouseAdapter {
    async fn connect(&self, config: &ConnectionConfig) -> Result<Box<dyn DatabaseConnection>> {
        let client = clickhouse::Client::default()
            .with_url(&format!("http://{}:{}", config.host, config.port))
            .with_user(&config.username)
            .with_password(&config.password);
        Ok(Box::new(ClickHouseConnection::new(client)))
    }
}

// ClickHouse 特性支持
// - 超高性能OLAP查询
// - 列式存储和压缩
// - 实时数据插入和查询
// - 分布式架构支持
```

##### **QuestDB 集成方案**

```rust
// QuestDB 适配器实现
pub struct QuestDBAdapter;

impl DatabaseAdapter for QuestDBAdapter {
    async fn connect(&self, config: &ConnectionConfig) -> Result<Box<dyn DatabaseConnection>> {
        // 通过PostgreSQL协议连接QuestDB
        let pg_config = tokio_postgres::Config::new()
            .host(&config.host)
            .port(config.port as u16)
            .user(&config.username)
            .password(&config.password);
        let (client, connection) = pg_config.connect(tokio_postgres::NoTls).await?;
        Ok(Box::new(QuestDBConnection::new(client)))
    }
}

// QuestDB 特性支持
// - 专业时序数据处理
// - 高性能时间序列查询
// - SQL和InfluxDB Line Protocol
// - 实时流数据处理
```

## 4. 模块设计

### 4.1 连接管理模块

#### 4.1.1 前端组件

```typescript
// ConnectionManager.tsx
interface ConnectionManagerProps {
  connections: DatabaseConnection[];
  onAddConnection: (connection: DatabaseConnection) => void;
  onEditConnection: (id: string, connection: DatabaseConnection) => void;
  onDeleteConnection: (id: string) => void;
  onTestConnection: (connection: DatabaseConnection) => Promise<boolean>;
}

// ConnectionForm.tsx
interface ConnectionFormProps {
  connection?: DatabaseConnection;
  onSubmit: (connection: DatabaseConnection) => void;
  onCancel: () => void;
}
```

#### 4.1.2 后端服务

```rust
// ConnectionService
pub struct ConnectionService {
    config_store: ConfigStore,
    adapters: HashMap<DatabaseType, Box<dyn DatabaseAdapter>>,
}

impl ConnectionService {
    pub async fn create_connection(&self, config: ConnectionConfig) -> Result<String>;
    pub async fn update_connection(&self, id: &str, config: ConnectionConfig) -> Result<()>;
    pub async fn delete_connection(&self, id: &str) -> Result<()>;
    pub async fn test_connection(&self, config: &ConnectionConfig) -> Result<bool>;
    pub async fn get_connections(&self) -> Result<Vec<ConnectionConfig>>;
}
```

### 4.2 数据库浏览模块

#### 4.2.1 前端组件

```typescript
// DatabaseExplorer.tsx
interface DatabaseExplorerProps {
  connection: DatabaseConnection;
  onTableSelect: (table: TableInfo) => void;
}

// DatabaseTree.tsx - 数据库结构树形展示
// TableViewer.tsx - 表格数据查看
// QueryEditor.tsx - SQL/NoSQL 查询编辑器
```

#### 4.2.2 后端服务

```rust
// DatabaseService
pub struct DatabaseService {
    connections: HashMap<String, Box<dyn DatabaseConnection>>,
}

impl DatabaseService {
    pub async fn get_database_list(&self, connection_id: &str) -> Result<Vec<String>>;
    pub async fn get_table_list(&self, connection_id: &str, database: &str) -> Result<Vec<TableInfo>>;
    pub async fn execute_query(&self, connection_id: &str, query: &str) -> Result<QueryResult>;
    pub async fn get_table_data(&self, connection_id: &str, table: &str, limit: u32, offset: u32) -> Result<TableData>;
}
```

### 4.3 文档管理模块

#### 4.3.1 前端组件

```typescript
// DocumentManager.tsx
interface DocumentManagerProps {
  documents: Document[];
  onCreateDocument: (document: Document) => void;
  onUpdateDocument: (id: string, document: Document) => void;
  onDeleteDocument: (id: string) => void;
}

// DocumentEditor.tsx - Markdown 编辑器
// DocumentViewer.tsx - 文档预览
// DocumentSearch.tsx - 文档搜索
```

#### 4.3.2 后端服务

```rust
// DocumentService
pub struct DocumentService {
    storage: DocumentStorage,
}

impl DocumentService {
    pub async fn create_document(&self, document: Document) -> Result<String>;
    pub async fn update_document(&self, id: &str, document: Document) -> Result<()>;
    pub async fn delete_document(&self, id: &str) -> Result<()>;
    pub async fn get_documents(&self) -> Result<Vec<Document>>;
    pub async fn search_documents(&self, query: &str) -> Result<Vec<Document>>;
}
```

## 5. 数据模型设计

### 5.1 核心数据模型

```typescript
// 数据库连接配置
interface DatabaseConnection {
  id: string;
  name: string;
  type: DatabaseType;
  host: string;
  port: number;
  database?: string;
  username: string;
  password: string; // 加密存储
  ssl: boolean;
  options: Record<string, any>;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

// 数据库类型枚举
enum DatabaseType {
  // 关系型数据库
  MySQL = 'mysql',
  PostgreSQL = 'postgresql',
  SQLite = 'sqlite',
  SqlServer = 'sqlserver',
  Oracle = 'oracle',
  
  // 分析型数据库
  DuckDB = 'duckdb',
  ClickHouse = 'clickhouse',
  QuestDB = 'questdb',
  ApacheDrill = 'drill',
  
  // 非关系型数据库
  MongoDB = 'mongodb',
  Redis = 'redis',
  Elasticsearch = 'elasticsearch',
  InfluxDB = 'influxdb',
  TimescaleDB = 'timescaledb',
  
  // 图数据库
  Neo4j = 'neo4j',
  ArangoDB = 'arangodb',
  
  // 云数据库
  BigQuery = 'bigquery',
  Snowflake = 'snowflake',
  Databricks = 'databricks',
  Redshift = 'redshift',
}

// 表信息
interface TableInfo {
  name: string;
  schema?: string;
  type: 'table' | 'view' | 'collection';
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  rowCount: number;
}

// 文档模型
interface Document {
  id: string;
  title: string;
  content: string;
  type: 'connection' | 'schema' | 'query' | 'manual';
  connectionId?: string;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}
```

### 5.2 Rust 数据模型

```rust
// 数据库连接配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub db_type: DatabaseType,
    pub host: String,
    pub port: u16,
    pub database: Option<String>,
    pub username: String,
    pub password: String,
    pub ssl: bool,
    pub options: HashMap<String, serde_json::Value>,
    pub tags: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

// 查询结果
#[derive(Debug, Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub affected_rows: u64,
    pub execution_time: Duration,
}
```

## 6. API 设计

> **本节已移除。** 它列过 11 条 Tauri 命令与两个前端 service 类，而其中
> `get_databases`、`get_tables`、`create_document`、`update_document`、
> `get_documents` 从未实现，`execute_query` 的签名已完全不同（现在是一个
> request 结构加一个 Channel，带行数与字节上限），`ConnectionService` /
> `DatabaseService` 两个类所在的 `src/services/` 目录根本不存在。
>
> 照着一份写着不存在的函数的文档写代码，要到编译期才发现——留着比删掉更糟。
>
> 命令的权威清单是 `src-tauri/src/lib.rs` 里 `invoke_handler` 的那一段
> （当前 28 条）；每条的签名在 `src-tauri/src/commands/` 下。

## 7. 界面设计

### 7.1 主界面布局

```bash
┌─────────────────────────────────────────────────────────┐
│ Header (Logo, Menu, User Profile)                       │
├─────────────────────────────────────────────────────────┤
│ ┌─────────────-┐ ┌─────────────────────────────────────┐ │
│ │              │ │                                     │ │
│ │  Sidebar     │ │         Main Content Area           │ │
│ │              │ │                                     │ │
│ │ - Connections│ │ - Database Explorer                 │ │
│ │ - Documents  │ │ - Query Editor                      │ │
│ │ - Settings   │ │ - Results Viewer                    │ │
│ │              │ │ - Document Editor                   │ │
│ │              │ │                                     │ │
│ └─────────────-┘ └─────────────────────────────────────┘ │
├─────────────────────────────────────────────────────────┤
│ Status Bar (Connection Status, Notifications)           │
└─────────────────────────────────────────────────────────┘
```

### 7.2 主要页面组件

#### 7.2.1 连接管理页面

- 连接列表展示（卡片式布局）
- 连接分组和标签过滤
- 连接状态指示器
- 快速连接按钮

#### 7.2.2 数据库浏览页面

- 左侧树形结构展示数据库、表
- 右侧多标签页展示表数据、结构、索引等
- 顶部工具栏（刷新、搜索、导出等）

#### 7.2.3 查询编辑器

- 支持语法高亮的代码编辑器
- 查询历史记录
- 结果集分页展示
- 查询性能指标

#### 7.2.4 文档管理页面

- 文档列表（支持搜索和过滤）
- Markdown 编辑器
- 文档预览
- 版本历史

## 8. 测试策略

### 8.1 测试金字塔

```bash
┌─────────────────┐
│   E2E Tests     │  <- 端到端测试
│   (Cypress)     │
├─────────────────┤
│ Integration     │  <- 集成测试
│ Tests (Jest)    │
├─────────────────┤
│  Unit Tests     │  <- 单元测试
│ (Jest + Rust)   │
└─────────────────┘
```

### 8.2 TDD 实践

#### 8.2.1 前端测试

```typescript
// connectionStore.test.ts
describe('ConnectionStore', () => {
  it('should add a new connection', () => {
    const store = useConnectionStore();
    const connection = createMockConnection();
    
    store.addConnection(connection);
    
    expect(store.connections).toContain(connection);
  });
  
  it('should test connection successfully', async () => {
    const store = useConnectionStore();
    const connection = createMockConnection();
    
    const result = await store.testConnection(connection);
    
    expect(result).toBe(true);
  });
});
```

#### 8.2.2 后端测试

```rust
// connection_service.rs
#[cfg(test)]
mod tests {
    use super::*;
    
    #[tokio::test]
    async fn test_create_connection() {
        let service = ConnectionService::new();
        let config = create_test_config();
        
        let result = service.create_connection(config).await;
        
        assert!(result.is_ok());
    }
    
    #[tokio::test]
    async fn test_connection_validation() {
        let service = ConnectionService::new();
        let invalid_config = create_invalid_config();
        
        let result = service.test_connection(&invalid_config).await;
        
        assert!(result.is_err());
    }
}
```

### 8.3 测试覆盖率目标

- 单元测试覆盖率：>= 90%
- 集成测试覆盖率：>= 80%
- 端到端测试覆盖率：>= 70%

## 9. 性能优化

### 9.1 前端优化

- 使用 React.memo 优化组件渲染
- 虚拟列表处理大数据量
- 懒加载和代码分割
- 状态管理优化（避免不必要的更新）

### 9.2 后端优化

- 连接池管理
- 查询结果缓存
- 异步处理
- 内存管理优化

### 9.3 数据库优化

- 分页查询
- 索引优化建议
- 查询计划分析
- 慢查询监控

## 10. 安全考虑

### 10.1 数据安全

- 连接密码 AES 加密存储
- 本地数据库密钥管理
- 敏感数据脱敏显示

### 10.2 连接安全

- SSL/TLS 连接支持
- 证书验证
- 连接超时控制
- IP 白名单支持

### 10.3 操作安全

- 用户权限控制
- 危险操作确认
- 操作审计日志
- 数据备份建议

## 11. 部署和发布

### 11.1 构建流程

```bash
# 前端构建
bun run build

# 后端构建
cargo build --release

# 打包应用
bunx tauri build
```

### 11.2 发布策略

- 自动化 CI/CD 流程
- 多平台构建
- 版本管理和更新
- 崩溃报告收集

## 12. 分析型数据库深度支持

### 12.1 为什么支持分析型数据库

分析型数据库在现代数据工程和数据科学工作流中扮演着越来越重要的角色：

#### 12.1.1 技术趋势

- **数据量爆炸式增长**：传统OLTP数据库难以处理大规模数据分析
- **实时分析需求**：业务需要实时洞察，传统离线分析无法满足
- **成本优化**：列式存储和压缩技术大幅降低存储成本
- **易用性提升**：新一代分析数据库SQL兼容性更好

#### 12.1.2 应用场景

- **数据仓库**：企业级数据仓库和数据湖分析
- **实时BI**：实时报表和仪表板
- **时序分析**：IoT数据、监控数据、财务数据分析
- **机器学习**：特征工程和模型训练数据准备

### 12.2 DuckDB - 嵌入式分析引擎

#### 12.2.1 技术特点

```rust
// DuckDB 连接实现
impl DuckDBConnection {
    pub async fn execute_analytical_query(&self, query: &str) -> Result<QueryResult> {
        // 支持复杂分析查询
        // SELECT sales_date, SUM(amount) OVER (ORDER BY sales_date ROWS 7 PRECEDING) as rolling_sum
        // FROM sales_data
        // WHERE sales_date >= '2024-01-01'
    }
    
    pub async fn import_file(&self, format: &str, path: &str) -> Result<()> {
        match format {
            "parquet" => self.conn.execute(&format!("CREATE TABLE data AS SELECT * FROM read_parquet('{}')", path), [])?,
            "csv" => self.conn.execute(&format!("CREATE TABLE data AS SELECT * FROM read_csv_auto('{}')", path), [])?,
            "json" => self.conn.execute(&format!("CREATE TABLE data AS SELECT * FROM read_json_auto('{}')", path), [])?,
            _ => return Err("Unsupported format".into()),
        }
        Ok(())
    }
}
```

#### 12.2.2 独特优势

- **零配置**：无需安装服务器，直接嵌入应用
- **多格式支持**：原生支持Parquet、CSV、JSON等格式
- **高性能**：向量化执行引擎，列式存储
- **SQL兼容**：完整SQL支持，兼容PostgreSQL

### 12.3 ClickHouse - 大数据OLAP引擎

#### 12.3.1 连接配置界面

```typescript
// ClickHouse 专用配置表单
interface ClickHouseConfig {
  host: string;
  httpPort: number;      // HTTP接口端口 (默认8123)
  nativePort: number;    // Native接口端口 (默认9000)
  database: string;
  username: string;
  password: string;
  compression: boolean;  // 启用压缩
  secure: boolean;       // 使用HTTPS
  settings: {
    maxMemoryUsage?: number;
    maxExecutionTime?: number;
    useUncompressedCache?: boolean;
  };
}
```

#### 12.3.2 性能优化特性

```rust
impl ClickHouseConnection {
    pub async fn execute_with_settings(&self, query: &str, settings: &HashMap<String, String>) -> Result<QueryResult> {
        // 支持查询级别的性能设置
        let mut query_with_settings = format!("SET ");
        for (key, value) in settings {
            query_with_settings.push_str(&format!("{}={}, ", key, value));
        }
        query_with_settings.push_str(&query);
        
        self.client.query(&query_with_settings).fetch_all().await
    }
    
    pub async fn get_query_log(&self) -> Result<Vec<QueryLogEntry>> {
        // 查询系统表获取性能指标
        let query = "SELECT query, query_duration_ms, memory_usage, read_rows FROM system.query_log ORDER BY event_time DESC LIMIT 100";
        self.execute_query(query).await
    }
}
```

### 12.4 前端界面适配

#### 12.5.1 分析型数据库连接表单

```typescript
// 分析型数据库专用UI组件
const AnalyticalDBForm: React.FC<{dbType: DatabaseType}> = ({ dbType }) => {
  switch (dbType) {
    case DatabaseType.DuckDB:
      return <DuckDBConnectionForm />;
    case DatabaseType.ClickHouse:
      return <ClickHouseConnectionForm />;
    case DatabaseType.QuestDB:
      return <QuestDBConnectionForm />;
  }
};

// DuckDB 连接表单 - 支持文件/内存模式
const DuckDBConnectionForm = () => (
  <div className="space-y-4">
    <RadioGroup value={mode} onValueChange={setMode}>
      <RadioGroupItem value="file">文件数据库</RadioGroupItem>
      <RadioGroupItem value="memory">内存数据库</RadioGroupItem>
    </RadioGroup>
    {mode === 'file' && (
      <Input 
        placeholder="数据库文件路径" 
        value={filePath}
        onChange={(e) => setFilePath(e.target.value)}
      />
    )}
  </div>
);
```

#### 12.5.2 查询编辑器增强

```typescript
// 分析型数据库查询模板
const analyticalQueryTemplates = {
  [DatabaseType.DuckDB]: [
    {
      name: "导入Parquet文件",
      template: "CREATE TABLE my_table AS SELECT * FROM read_parquet('file.parquet');"
    },
    {
      name: "时间窗口聚合",
      template: "SELECT date_trunc('hour', timestamp) as hour, COUNT(*) FROM events GROUP BY hour;"
    }
  ],
  [DatabaseType.ClickHouse]: [
    {
      name: "物化视图",
      template: "CREATE MATERIALIZED VIEW mv_hourly_stats ENGINE = AggregatingMergeTree() ORDER BY hour AS SELECT toStartOfHour(timestamp) as hour, countState() as cnt FROM events GROUP BY hour;"
    }
  ]
};
```

### 12.5 性能监控仪表板

#### 12.6.1 分析型数据库性能指标

```typescript
interface AnalyticalDBMetrics {
  // 查询性能
  queryDuration: number;
  rowsProcessed: number;
  memoryUsage: number;
  
  // ClickHouse 特有指标
  compressionRatio?: number;
  diskSpaceUsed?: number;
  
  // DuckDB 特有指标  
  vectorizedOperations?: number;
  
  // QuestDB 特有指标
  ingestionRate?: number;
  timeSeriesCount?: number;
}

const PerformanceMonitor: React.FC<{connection: DatabaseConnection}> = ({ connection }) => {
  const metrics = useAnalyticalMetrics(connection.id);
  
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4">
      <MetricCard 
        title="查询耗时" 
        value={`${metrics.queryDuration}ms`}
        trend={metrics.queryDurationTrend}
      />
      <MetricCard 
        title="处理行数" 
        value={formatNumber(metrics.rowsProcessed)}
      />
      {/* 根据数据库类型显示特定指标 */}
    </div>
  );
};
```

### 12.6 集成优势总结

通过支持这些分析型数据库，DataOmni 将成为：

1. **现代数据栈的中心枢纽**：连接从操作型到分析型的完整数据生态
2. **开发者友好的分析工具**：提供SQL和可视化界面，降低数据分析门槛  
3. **性能优化的查询平台**：针对不同数据库优化查询执行和结果展示
4. **企业级数据管理方案**：支持从小规模到大规模的各种数据分析需求

## 13. 扩展性设计

### 13.1 插件系统

- 数据库驱动插件
- 主题插件
- 功能扩展插件

### 13.2 API 开放

- 命令行接口
- REST API 支持
- 脚本化操作

### 13.3 国际化

- 多语言支持
- 本地化配置
- 右到左语言支持

## 14. 开发规范

### 14.1 代码规范

- TypeScript 严格模式
- ESLint + Prettier
- Rust Clippy
- Git Hooks 检查

### 14.2 提交规范

- Conventional Commits
- 分支管理策略
- PR 审查流程

### 14.3 文档规范

- README 维护
- API 文档生成
- 变更日志
- 用户手册

## 15. 项目里程碑

> 这一节原本是一份 16 周、四个 Phase 的计划。它已被 `TODOs.md` 的 P0–P5 与
> 发布里程碑取代——那份是活的，每条都带取舍理由、判据与反向验证记录。

## 16. 总结

本设计文档基于现代软件工程的最佳实践，采用了高内聚、低耦合的模块化设计理念。通过 TDD 驱动开发，确保代码质量和可维护性。前后端分离的架构使得系统具有良好的扩展性和可维护性。

设计的核心优势：

1. **模块化设计**：各功能模块独立，便于开发和维护
2. **类型安全**：TypeScript 和 Rust 的类型系统保证代码安全
3. **测试驱动**：完善的测试策略确保功能正确性
4. **性能优化**：从架构层面考虑性能优化
5. **安全可靠**：全面的安全措施保护用户数据
6. **用户体验**：现代化的 UI 设计和交互体验

这个设计为 DataOmni 项目提供了一个坚实的技术基础，可以支持项目的快速迭代和长期发展。
