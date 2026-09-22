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
  DATAOMNI_SSH_AUTH_REJECTED: 'error.backend.sshAuthRejected',
  DATAOMNI_SSH_FAILED: 'error.backend.sshFailed',
  DATAOMNI_SSH_HOST_KEY_CERTIFICATE: 'error.backend.sshHostKeyCertificate',
  DATAOMNI_SSH_KNOWN_HOSTS_UNREADABLE: 'error.backend.sshKnownHostsUnreadable',
  DATAOMNI_SSH_CONNECT_TIMEOUT: 'error.backend.sshConnectTimeout',
  DATAOMNI_SSH_LOCAL_PORT_UNAVAILABLE: 'error.backend.sshLocalPortUnavailable',
  DATAOMNI_SSH_TUNNEL_NOT_ESTABLISHED: 'error.backend.sshTunnelNotEstablished',
  DATAOMNI_DB_SESSION_NOT_CONNECTED: 'error.backend.dbSessionNotConnected'
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
