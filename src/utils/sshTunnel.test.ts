import { describe, expect, it } from 'vitest';
import { DatabaseType } from '../contracts/connection';
import {
  SSH_DEFAULT_PORT,
  createDefaultSshTunnel,
  hasStoredSecret,
  isSshTunnelBlank,
  normalizeSshTunnel,
  sshTunnelProblems,
  supportsSshTunnel
} from './sshTunnel';

describe('sshTunnel', () => {
  it('只有走网络的类型用得上隧道', () => {
    expect(supportsSshTunnel(DatabaseType.MySQL)).toBe(true);
    expect(supportsSshTunnel(DatabaseType.PostgreSQL)).toBe(true);
    // SQLite 的「连接」是打开一个本地文件，转发 TCP 对它没有意义
    expect(supportsSshTunnel(DatabaseType.SQLite)).toBe(false);
    expect(supportsSshTunnel(DatabaseType.DuckDB)).toBe(false);
  });

  it('刚建出来的配置三项全缺，默认端口是 22', () => {
    const tunnel = createDefaultSshTunnel();
    expect(tunnel.port).toBe(SSH_DEFAULT_PORT);
    expect(sshTunnelProblems(tunnel)).toEqual(['host', 'username', 'privateKeyPath']);
  });

  it('刚勾开的隧道算「空的」，填了任何一格就不算', () => {
    expect(isSshTunnelBlank(createDefaultSshTunnel())).toBe(true);
    // 端口有默认值 22，不能因为它就认为用户动过
    expect(isSshTunnelBlank({ ...createDefaultSshTunnel(), port: 22 })).toBe(true);

    expect(isSshTunnelBlank({ ...createDefaultSshTunnel(), host: 'jump' })).toBe(false);
    expect(isSshTunnelBlank({ ...createDefaultSshTunnel(), remote_port: 3306 })).toBe(false);
    // 只有空格仍然算没填
    expect(isSshTunnelBlank({ ...createDefaultSshTunnel(), host: '   ' })).toBe(true);
  });

  it('只有空格不算填了', () => {
    // 复制粘贴带进来的空格：留着的话后端会报「文件不存在」，
    // 而用户看着那一行路径以为是对的
    expect(
      sshTunnelProblems({
        ...createDefaultSshTunnel(),
        host: '  ',
        username: ' ',
        private_key_path: '\t'
      })
    ).toEqual(['host', 'username', 'privateKeyPath']);
  });

  it('端口超范围或不是整数都要点出来', () => {
    const base = { ...createDefaultSshTunnel(), host: 'jump', username: 'ops', private_key_path: '/k' };
    expect(sshTunnelProblems({ ...base, port: 0 })).toEqual(['port']);
    expect(sshTunnelProblems({ ...base, port: 70000 })).toEqual(['port']);
    expect(sshTunnelProblems({ ...base, port: 22.5 })).toEqual(['port']);
    expect(sshTunnelProblems({ ...base, port: 2222 })).toEqual([]);
  });

  it('口令登录不要求私钥路径，但要求口令', () => {
    const base = { ...createDefaultSshTunnel(), host: 'jump', username: 'ops', auth: 'password' as const };
    // 对着一个必填的「私钥文件」无从下手——那一格对口令登录毫无意义
    expect(sshTunnelProblems(base)).toEqual(['password']);
    expect(sshTunnelProblems({ ...base, secret: 'hunter2' })).toEqual([]);
  });

  /**
   * 私钥的**口令**是可空的：没加密的私钥不需要它。把它也设成必填，
   * 等于让第一个增量支持的那种钥匙突然用不了了。
   */
  it('私钥登录不要求口令', () => {
    expect(
      sshTunnelProblems({
        ...createDefaultSshTunnel(),
        host: 'jump',
        username: 'ops',
        private_key_path: '/k'
      })
    ).toEqual([]);
  });

  // 界面不会把存着的口令回填。分不清「空」和「没有」的后果是：
  // 编辑一次连接就被要求重填口令，而不填就报「还差口令」——一条走不通的路
  it('钥匙串里已经有一份时，口令那一格留空不算缺', () => {
    const stored = {
      ...createDefaultSshTunnel(),
      host: 'jump',
      username: 'ops',
      auth: 'password' as const,
      secret_ref: 'system-keyring://connection/p1#ssh'
    };
    expect(hasStoredSecret(stored)).toBe(true);
    expect(sshTunnelProblems(stored)).toEqual([]);
    // 而且它不算「一格都没填」，否则整段提示会消失
    expect(isSshTunnelBlank(stored)).toBe(false);
  });

  // 空格是合法的口令字符。两端剪掉等于悄悄改了用户的密钥，而报出来的是
  // 「口令不对」——指向服务器，而问题在这一行代码
  it('口令两端的空格不剪', () => {
    const tunnel = normalizeSshTunnel({
      ...createDefaultSshTunnel(),
      host: 'jump',
      username: 'ops',
      auth: 'password',
      secret: '  pass  '
    });
    expect(tunnel.secret).toBe('  pass  ');
  });

  // 留着私钥路径会让后端以为还要读那个文件
  it('切到口令登录之后不再把私钥路径带给后端', () => {
    const tunnel = normalizeSshTunnel({
      ...createDefaultSshTunnel(),
      host: 'jump',
      username: 'ops',
      auth: 'password',
      secret: 'x',
      private_key_path: '/home/me/.ssh/id_rsa'
    });
    expect(tunnel.private_key_path).toBe('');
  });

  it('整理之后转发目标留空就是不传，而不是传一个空字符串', () => {
    const tunnel = normalizeSshTunnel({
      ...createDefaultSshTunnel(),
      host: ' jump.example.com ',
      username: ' ops ',
      private_key_path: ' /home/me/.ssh/id_rsa ',
      remote_host: '   ',
      remote_port: 0
    });

    expect(tunnel).toEqual({
      host: 'jump.example.com',
      port: 22,
      username: 'ops',
      private_key_path: '/home/me/.ssh/id_rsa',
      auth: 'private-key',
      secret: ''
    });
    // 键必须是不存在，不是 undefined——serde 那边 `Option` 靠键缺失来定
    expect('remote_host' in tunnel).toBe(false);
    expect('remote_port' in tunnel).toBe(false);
  });

  it('填了转发目标就原样带上', () => {
    const tunnel = normalizeSshTunnel({
      ...createDefaultSshTunnel(),
      host: 'jump',
      username: 'ops',
      private_key_path: '/k',
      remote_host: '127.0.0.1',
      remote_port: 23306
    });

    expect(tunnel.remote_host).toBe('127.0.0.1');
    expect(tunnel.remote_port).toBe(23306);
  });
});
