pub mod completion_catalog;
pub mod connection_probe;
pub mod connection_service;
pub mod csv_import;
pub mod er_diagram;
pub mod explain;
pub mod export_writer;
pub mod object_catalog;
pub mod oracle;
pub mod pool_registry;
pub mod query_error;
pub mod query_executor;
pub mod query_session;
pub mod schema_metadata;
pub mod session_target;
pub mod sql_server;
pub mod sqlx_pool;
pub mod ssh_tunnel;
pub mod transaction_state;
pub mod write_batch;

pub use completion_catalog::{completion_catalog_query, CompletionCatalogQuery};
pub use connection_probe::{diagnose, ConnectionDiagnosis, DiagnosisStep};
pub use connection_service::ConnectionService;
pub use csv_import::{
  import_csv, preview_csv, CsvOptions, CsvPreview, ErrorPolicy, ImportProgress, ImportRequest,
  ImportSummary, TransactionStrategy, PREVIEW_ROWS,
};
pub use er_diagram::{er_diagram_queries, ErDiagramQueries};
pub use explain::{
  explain_statement, parse_plan, supports_analyze, PlanDialect, PlanNode, QueryPlan,
  SERVER_VERSION_QUERY,
};
pub use export_writer::{
  export_query, ExportFormat, ExportOptions, ExportProgress, ExportSummary, ExportWriter,
  EXPORT_CANCELLED_CODE,
};
pub use object_catalog::{object_catalog_queries, ObjectCatalogQueries};
pub use query_error::QueryError;
pub use query_executor::{
  execute_query, execute_query_with_limit, execute_query_with_limits, execute_query_with_timeout,
  NonQueryHandling, PoolRef, QueryColumnMetadata, QueryExecutionResult, QueryExecutionSummary,
  QueryResultBatch, QueryRow, QueryTruncationReason, SessionConnection, StreamOptions,
  DEFAULT_QUERY_BATCH_SIZE, DEFAULT_QUERY_BYTE_LIMIT, DEFAULT_QUERY_ROW_LIMIT, NON_QUERY_MESSAGE,
  QUERY_TIMEOUT_CODE, USE_STATEMENT_REFUSED,
};
pub use query_session::{QuerySessionState, StreamingQueryOptions};
pub use schema_metadata::{schema_metadata_queries, DdlQuery, SchemaMetadataQueries};
pub use session_target::{session_target_query, SessionTargetQuery};
pub use sql_server::{SqlServerPool, SqlServerRegistry, SqlServerTarget, SQL_SERVER_SCHEME};
pub use ssh_tunnel::{ActiveTunnel, TunnelError, TunnelRegistry};
pub use transaction_state::{TransactionState, TransactionStatus};
pub use write_batch::{
  execute_write_batch, WriteBatchError, WriteStatement, ROW_COUNT_MISMATCH_CODE,
};
