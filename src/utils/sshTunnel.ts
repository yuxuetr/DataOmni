import { DatabaseType, type SshTunnelConfig } from '../contracts/connection';

/**
 * SSH 隧道表单的判断逻辑。组件只负责画，不在分支里做决定。
 *
 * 设计说明在 `rfcs/ssh-tunnel.md`。这里只处理「这份配置能不能用」和
 * 「哪些类型用得上隧道」两件事。
 */

export const SSH_DEFAULT_PORT = 22;

/** 隧道转发的是 TCP，所以只有走网络的类型用得上 */
export function supportsSshTunnel(dbType: DatabaseType): boolean {
  return dbType !== DatabaseType.SQLite && dbType !== DatabaseType.DuckDB;
}

export function createDefaultSshTunnel(): SshTunnelConfig {
  return {
    host: '',
    port: SSH_DEFAULT_PORT,
    username: '',
    private_key_path: ''
  };
}

/**
 * 一个字段都没填。
 *
 * 刚勾开隧道时整段都是空的，那时把「还差三项」标红等于在说用户做错了什么——
 * 他还没开始填。填了一半才是真的需要提醒。
 */
export function isSshTunnelBlank(tunnel: SshTunnelConfig): boolean {
  return (
    !tunnel.host.trim() &&
    !tunnel.username.trim() &&
    !tunnel.private_key_path.trim() &&
    !tunnel.remote_host?.trim() &&
    !tunnel.remote_port
  );
}

/** 缺哪一项。返回的是字段名，由调用方决定怎么说 */
export type SshTunnelProblem = 'host' | 'username' | 'privateKeyPath' | 'port';

/**
 * 开了隧道却没填齐，后端会报一句 SSH 层的错（「连不上」「认证失败」），
 * 而真正的原因是这里有空格子。先在前端点出来。
 */
export function sshTunnelProblems(tunnel: SshTunnelConfig): SshTunnelProblem[] {
  const problems: SshTunnelProblem[] = [];
  if (!tunnel.host.trim()) {
    problems.push('host');
  }
  if (!tunnel.username.trim()) {
    problems.push('username');
  }
  if (!tunnel.private_key_path.trim()) {
    problems.push('privateKeyPath');
  }
  if (!Number.isInteger(tunnel.port) || tunnel.port < 1 || tunnel.port > 65535) {
    problems.push('port');
  }
  return problems;
}

/**
 * 交给后端之前收拾一遍。
 *
 * 两件事：路径与主机名两端的空格是复制粘贴带进来的，留着会让
 * `load_secret_key` 报「文件不存在」；转发目标的空字符串要变成
 * `undefined`，否则后端收到的是一个空主机名，而空主机名和「没填」
 * 在那边是同一件事，多绕一层不如在这里定好。
 */
export function normalizeSshTunnel(tunnel: SshTunnelConfig): SshTunnelConfig {
  const remoteHost = tunnel.remote_host?.trim();
  return {
    host: tunnel.host.trim(),
    port: tunnel.port,
    username: tunnel.username.trim(),
    private_key_path: tunnel.private_key_path.trim(),
    ...(remoteHost ? { remote_host: remoteHost } : {}),
    ...(tunnel.remote_port ? { remote_port: tunnel.remote_port } : {})
  };
}
