import { translateNow } from '../stores/languageStore';
import type { TranslationKey } from '../i18n/translate';

/**
 * 后端送上来的错误码 → 文案。
 *
 * 后端的错误串曾经是硬编码中文，于是英文界面上原样印中文。实际见过：把 SSH
 * 私钥填进 TLS 的「客户端私钥路径」之后，英文界面报的是「客户端证书和私钥
 * 必须同时配置」。
 *
 * 约定是 `CODE: 数据`——冒号后面只放数据（类型名、指纹、操作系统给的原因），
 * 句子在这里。**查不到的码原样返回**，所以后端加了新错误而这里忘了配，
 * 用户看到的不会比今天更糟，只是没被翻译。
 */
const MESSAGES: Readonly<Record<string, TranslationKey>> = {
  DATAOMNI_UNSUPPORTED_DATABASE: 'error.backend.unsupportedDatabase',
  DATAOMNI_TLS_CLIENT_PAIR_REQUIRED: 'error.backend.tlsClientPairRequired',
  DATAOMNI_TLS_CERTIFICATES_UNSUPPORTED: 'error.backend.tlsCertificatesUnsupported',
  DATAOMNI_SQLITE_PATH_REQUIRED: 'error.backend.sqlitePathRequired',
  DATAOMNI_HOST_REQUIRED: 'error.backend.hostRequired',
  DATAOMNI_USERNAME_REQUIRED: 'error.backend.usernameRequired',
  DATAOMNI_PORT_INVALID: 'error.backend.portInvalid',
  DATAOMNI_DATABASE_REQUIRED: 'error.backend.databaseRequired',
  DATAOMNI_KNOWN_HOSTS_NO_HOME: 'error.backend.knownHostsNoHome',
  DATAOMNI_SSH_HOST_KEY_CHANGED: 'error.backend.sshHostKeyChanged',
  DATAOMNI_SSH_HOST_KEY_UNKNOWN: 'error.backend.sshHostKeyUnknown',
  DATAOMNI_SSH_PRIVATE_KEY_UNREADABLE: 'error.backend.sshPrivateKeyUnreadable',
  DATAOMNI_SSH_PRIVATE_KEY_LOCKED: 'error.backend.sshPrivateKeyLocked',
  DATAOMNI_SSH_PRIVATE_KEY_PASSPHRASE: 'error.backend.sshPrivateKeyPassphrase',
  DATAOMNI_SSH_AUTH_REJECTED: 'error.backend.sshAuthRejected',
  DATAOMNI_SSH_FAILED: 'error.backend.sshFailed',
  DATAOMNI_SSH_HOST_KEY_CERTIFICATE: 'error.backend.sshHostKeyCertificate',
  DATAOMNI_SSH_KNOWN_HOSTS_UNREADABLE: 'error.backend.sshKnownHostsUnreadable',
  DATAOMNI_SSH_CONNECT_TIMEOUT: 'error.backend.sshConnectTimeout',
  DATAOMNI_SSH_LOCAL_PORT_UNAVAILABLE: 'error.backend.sshLocalPortUnavailable',
  DATAOMNI_SSH_TUNNEL_NOT_ESTABLISHED: 'error.backend.sshTunnelNotEstablished',
  DATAOMNI_DB_SESSION_NOT_CONNECTED: 'error.backend.dbSessionNotConnected',
  DATAOMNI_SERVICE_STATE_UNAVAILABLE: 'error.backend.serviceStateUnavailable',
  DATAOMNI_SERVICE_INIT_FAILED: 'error.backend.serviceInitFailed',
  DATAOMNI_SERVICE_NOT_READY: 'error.backend.serviceNotReady',
  DATAOMNI_CREDENTIAL_STORE_UNAVAILABLE: 'error.backend.credentialStoreUnavailable',
  DATAOMNI_CREDENTIAL_SAVE_FAILED: 'error.backend.credentialSaveFailed',
  DATAOMNI_CREDENTIAL_DELETE_FAILED: 'error.backend.credentialDeleteFailed',
  DATAOMNI_CREDENTIAL_MISSING: 'error.backend.credentialMissing',
  DATAOMNI_CREDENTIAL_MIGRATION_FAILED: 'error.backend.credentialMigrationFailed',
  DATAOMNI_CONFIG_DIR_UNAVAILABLE: 'error.backend.configDirUnavailable',
  DATAOMNI_CONFIG_SAVE_FAILED: 'error.backend.configSaveFailed',
  DATAOMNI_CONNECTION_NOT_FOUND: 'error.backend.connectionNotFound',
  DATAOMNI_DIRECTORY_MISSING: 'error.backend.directoryMissing',
  DATAOMNI_FILE_WRITE_FAILED: 'error.backend.fileWriteFailed',
  DATAOMNI_FILE_READ_FAILED: 'error.backend.fileReadFailed',
  DATAOMNI_FILE_OPEN_FAILED: 'error.backend.fileOpenFailed',
  DATAOMNI_FILE_CREATE_FAILED: 'error.backend.fileCreateFailed',
  DATAOMNI_FILE_RENAME_FAILED: 'error.backend.fileRenameFailed',
  DATAOMNI_FILE_SIZE_FAILED: 'error.backend.fileSizeFailed',
  DATAOMNI_BASE64_INVALID: 'error.backend.base64Invalid',
  DATAOMNI_FILE_NOT_UTF8: 'error.backend.fileNotUtf8',
  DATAOMNI_EXECUTION_ID_IN_USE: 'error.backend.executionIdInUse',
  DATAOMNI_TIMEOUT_OUT_OF_RANGE: 'error.backend.timeoutOutOfRange',
  DATAOMNI_ROW_LIMIT_OUT_OF_RANGE: 'error.backend.rowLimitOutOfRange',
  DATAOMNI_BYTE_LIMIT_OUT_OF_RANGE: 'error.backend.byteLimitOutOfRange',
  DATAOMNI_QUERY_CANCELLED: 'error.backend.queryCancelled',
  DATAOMNI_EXPORT_CANCELLED: 'error.backend.exportCancelled',
  DATAOMNI_EXPORT_WRITE_FAILED: 'error.backend.exportWriteFailed',
  DATAOMNI_CSV_DELIMITER_INVALID: 'error.backend.csvDelimiterInvalid',
  DATAOMNI_CSV_PARSE_FAILED: 'error.backend.csvParseFailed',
  DATAOMNI_CSV_PREVIEW_FAILED: 'error.backend.csvPreviewFailed',
  DATAOMNI_CSV_NO_COLUMN_MAPPED: 'error.backend.csvNoColumnMapped',
  DATAOMNI_SCHEMA_BROWSE_UNSUPPORTED: 'error.backend.schemaBrowseUnsupported',
  DATAOMNI_OBJECT_BROWSE_UNSUPPORTED: 'error.backend.objectBrowseUnsupported',
  DATAOMNI_ER_DIAGRAM_UNSUPPORTED: 'error.backend.erDiagramUnsupported',
  DATAOMNI_COMPLETION_CATALOG_UNSUPPORTED: 'error.backend.completionCatalogUnsupported',
  DATAOMNI_SESSION_TARGET_UNSUPPORTED: 'error.backend.sessionTargetUnsupported',
  DATAOMNI_EXPLAIN_UNSUPPORTED: 'error.backend.explainUnsupported',
  DATAOMNI_EXPLAIN_ANALYZE_UNSUPPORTED: 'error.backend.explainAnalyzeUnsupported',
  DATAOMNI_EXPLAIN_EMPTY: 'error.backend.explainEmpty',
  DATAOMNI_EXPLAIN_NOT_JSON: 'error.backend.explainNotJson',
  DATAOMNI_EXPLAIN_NOT_XML: 'error.backend.explainNotXml',
  DATAOMNI_SESSION_ID_EMPTY: 'error.backend.sessionIdEmpty',
  DATAOMNI_SESSION_BOUND_ELSEWHERE: 'error.backend.sessionBoundElsewhere',
  DATAOMNI_UNSUPPORTED_COLUMN_TYPE: 'error.backend.unsupportedColumnType',
  DATAOMNI_UNSUPPORTED_PARAMETER_TYPE: 'error.backend.unsupportedParameterType',
  DATAOMNI_QUERY_TIMEOUT: 'error.backend.queryTimeout',
  DATAOMNI_COLUMN_DECODE_FAILED: 'error.backend.columnDecodeFailed',
  DATAOMNI_NON_QUERY: 'error.backend.nonQuery',
  DATAOMNI_USE_STATEMENT_REFUSED: 'error.backend.useStatementRefused',
  DATAOMNI_SQL_SERVER_DRIVER_FAILURE: 'error.backend.sqlServerDriverFailure',
  DATAOMNI_CSV_COLUMN_TYPE_INVALID: 'error.backend.csvColumnTypeInvalid',
  DATAOMNI_CSV_ROW_TOO_SHORT: 'error.backend.csvRowTooShort',
  DATAOMNI_CSV_VALUE_NOT_CONVERTIBLE: 'error.backend.csvValueNotConvertible',
  DATAOMNI_ORACLE_CLIENT_MISSING: 'error.backend.oracleClientMissing',
  DATAOMNI_ORACLE_CLIENT_LOAD_FAILED: 'error.backend.oracleClientLoadFailed',
  DATAOMNI_ORACLE_TLS_UNSUPPORTED: 'error.backend.oracleTlsUnsupported',
  DATAOMNI_CSV_TRANSACTION_LOST: 'error.backend.csvTransactionLost',
  DATAOMNI_ROW_COUNT_MISMATCH: 'error.backend.rowCountMismatch',
  DATAOMNI_FILE_TOO_LARGE: 'error.backend.fileTooLarge',
  DATAOMNI_CREDENTIAL_STORE_REJECTED: 'error.backend.credentialStoreRejected',
  DATAOMNI_CONNECTION_LOST: 'error.backend.connectionLost',
  DATAOMNI_POOL_TIMED_OUT: 'error.backend.poolTimedOut',
  DATAOMNI_MONGO_SYNTAX: 'error.backend.mongoSyntax',
  DATAOMNI_MONGO_UNKNOWN_FUNCTION: 'error.backend.mongoUnknownFunction',
  DATAOMNI_MONGO_BAD_ARGUMENT: 'error.backend.mongoBadArgument',
  DATAOMNI_MONGO_NOT_DOCUMENT: 'error.backend.mongoNotDocument',
  DATAOMNI_MONGO_AUTH_FAILED: 'error.backend.mongoAuthFailed',
  DATAOMNI_MONGO_AUTH_REQUIRED: 'error.backend.mongoAuthRequired',
  DATAOMNI_MONGO_UNREACHABLE: 'error.backend.mongoUnreachable',
  DATAOMNI_MONGO_SERVER_ERROR: 'error.backend.mongoServerError',
  DATAOMNI_MONGO_TIMEOUT: 'error.backend.mongoTimeout',
  DATAOMNI_MONGO_DOCUMENT_GONE: 'error.backend.mongoDocumentGone',
  DATAOMNI_MONGO_DOCUMENT_CHANGED: 'error.backend.mongoDocumentChanged',
  DATAOMNI_MONGO_ID_CHANGED: 'error.backend.mongoIdChanged',
  DATAOMNI_MONGO_NO_SQL: 'error.backend.mongoNoSql',
  DATAOMNI_MONGO_IMPORT_JSON_ARRAY: 'error.backend.mongoImportJsonArray',
  DATAOMNI_MONGO_IMPORT_LINE_INVALID: 'error.backend.mongoImportLineInvalid',
  DATAOMNI_MONGO_INDEX_KEYS_EMPTY: 'error.backend.mongoIndexKeysEmpty',
  DATAOMNI_MONGO_INDEX_EXISTS: 'error.backend.mongoIndexExists',
  DATAOMNI_MONGO_BULK_STOPPED: 'error.backend.mongoBulkStopped',
  DATAOMNI_MONGO_UPDATE_NOT_OPERATORS: 'error.backend.mongoUpdateNotOperators',
  DATAOMNI_MONGO_PIPELINE_WRITES: 'error.backend.mongoPipelineWrites',
  DATAOMNI_MONGO_PIPELINE_INVALID: 'error.backend.mongoPipelineInvalid',
  DATAOMNI_MONGO_SRV_LOOKUP_FAILED: 'error.backend.mongoSrvLookupFailed',
  DATAOMNI_MONGO_SRV_WITH_TUNNEL: 'error.backend.mongoSrvWithTunnel',
  DATAOMNI_MONGO_TLS_FILE_INVALID: 'error.backend.mongoTlsFileInvalid',
  DATAOMNI_MONGO_CLIENT_KEY_SEPARATE: 'error.backend.mongoClientKeySeparate',
  DATAOMNI_MONGO_X509_NEEDS_CERTIFICATE: 'error.backend.mongoX509NeedsCertificate',
  DATAOMNI_MONGO_X509_REJECTED: 'error.backend.mongoX509Rejected',
  DATAOMNI_MONGO_NAME_EMPTY: 'error.backend.mongoNameEmpty',
  DATAOMNI_NEO4J_AUTH_FAILED: 'error.backend.neo4jAuthFailed',
  DATAOMNI_NEO4J_UNREACHABLE: 'error.backend.neo4jUnreachable',
  DATAOMNI_NEO4J_DATABASE_NOT_FOUND: 'error.backend.neo4jDatabaseNotFound',
  DATAOMNI_NEO4J_SERVER_ERROR: 'error.backend.neo4jServerError',
  DATAOMNI_NEO4J_TIMEOUT: 'error.backend.neo4jTimeout',
  DATAOMNI_NEO4J_TLS_FILE_INVALID: 'error.backend.neo4jTlsFileInvalid',
  DATAOMNI_REDIS_AUTH_FAILED: 'error.backend.redisAuthFailed',
  DATAOMNI_REDIS_AUTH_REQUIRED: 'error.backend.redisAuthRequired',
  DATAOMNI_REDIS_NO_PERMISSION: 'error.backend.redisNoPermission',
  DATAOMNI_REDIS_UNREACHABLE: 'error.backend.redisUnreachable',
  DATAOMNI_REDIS_SERVER_ERROR: 'error.backend.redisServerError',
  DATAOMNI_REDIS_TIMEOUT: 'error.backend.redisTimeout',
  DATAOMNI_REDIS_KEY_GONE: 'error.backend.redisKeyGone',
  DATAOMNI_REDIS_DATABASE_INVALID: 'error.backend.redisDatabaseInvalid',
  DATAOMNI_REDIS_TLS_FILE_INVALID: 'error.backend.redisTlsFileInvalid',
  DATAOMNI_REDIS_KEY_INVALID: 'error.backend.redisKeyInvalid',
  DATAOMNI_REDIS_COMMAND_BLOCKING: 'error.backend.redisCommandBlocking',
  DATAOMNI_REDIS_COMMAND_CONNECTION_STATE: 'error.backend.redisCommandConnectionState',
  DATAOMNI_REDIS_COMMAND_EMPTY: 'error.backend.redisCommandEmpty',
  DATAOMNI_REDIS_KEY_EXISTS: 'error.backend.redisKeyExists',
  DATAOMNI_REDIS_VALUE_CHANGED: 'error.backend.redisValueChanged',
  DATAOMNI_REDIS_ELEMENT_EXISTS: 'error.backend.redisElementExists',
  DATAOMNI_REDIS_ELEMENT_GONE: 'error.backend.redisElementGone'
};

export interface BackendError {
  readonly key: TranslationKey;
  /** 冒号后面那段数据。没有就是空串，文案里的 {detail} 会留空 */
  readonly detail: string;
}

/**
 * 认出一个后端错误码。认不出就是 `null`，由调用方把原串照原样显示。
 *
 * 只认**整串以码开头**的情况。驱动的错误里也可能出现大写下划线的词，
 * 在句子中间撞上一个同名的码就换掉整句话，会比不翻译更糟。
 */
export function parseBackendError(message: string): BackendError | null {
  const match = /^([A-Z][A-Z0-9_]*)(?::\s*([\s\S]*))?$/.exec(message.trim());
  if (!match) {
    return null;
  }

  const key = MESSAGES[match[1]];
  if (!key) {
    return null;
  }

  return { key, detail: (match[2] ?? '').trim() };
}

/**
 * 后端的错误串换成当前语言。认不出就原样返回（去掉两端空白）。
 *
 * 两条路都要走这里：`describeError` 处理 reject 的是字符串的命令，
 * `toQueryExecutionError` 处理 `execute_query` reject 的那个对象。
 * 只改一条的后果是另一条继续印中文，而两条在界面上长得一模一样。
 */
export function translateBackendMessage(message: string): string {
  const parsed = parseBackendError(message);
  if (!parsed) {
    return message.trim();
  }
  return translateNow(parsed.key, { detail: parsed.detail });
}
