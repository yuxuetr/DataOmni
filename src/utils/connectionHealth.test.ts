import { describe, expect, it } from 'vitest';
import {
  connectionHealth,
  offersReconnect,
  type ConnectionHealthInputs
} from './connectionHealth';

const connected: ConnectionHealthInputs = {
  isConnecting: false,
  connectionLost: false,
  hasSession: true,
  connectionReady: true,
  error: null
};

describe('connectionHealth', () => {
  it('接完线才算已连接', () => {
    expect(connectionHealth(connected)).toBe('connected');
  });

  // 这条是整个模块存在的理由：驱动把连接判死之后 Database 句柄照样在，
  // 先看句柄就会在连接已经没了的时候印「已连接」
  it('断线时句柄还在，但不能再说「已连接」', () => {
    expect(connectionHealth({ ...connected, connectionLost: true })).toBe('lost');
  });

  it('握手进行中压过一切', () => {
    expect(
      connectionHealth({ ...connected, isConnecting: true, connectionLost: true })
    ).toBe('connecting');
  });

  it('句柄有了但应用侧还没接完线，仍然是连接中，不是断开', () => {
    expect(connectionHealth({ ...connected, connectionReady: false })).toBe('connecting');
  });

  it('从来没连上是 failed，带着错误信息', () => {
    expect(
      connectionHealth({ ...connected, hasSession: false, connectionReady: false, error: '认证失败' })
    ).toBe('failed');
  });

  it('没有句柄也没有错误就是还没连', () => {
    expect(
      connectionHealth({ ...connected, hasSession: false, connectionReady: false })
    ).toBe('disconnected');
  });

  // 语句写错不是连接的问题。把它算成连接失败，用户会去重连一条好好的连接
  it('有句柄时的错误不影响连接状态', () => {
    expect(connectionHealth({ ...connected, error: '语法错误' })).toBe('connected');
  });
});

describe('offersReconnect', () => {
  it('断了和没连上都给重连入口', () => {
    expect(offersReconnect('lost')).toBe(true);
    expect(offersReconnect('failed')).toBe(true);
  });

  it('连着、连接中、未连接都不给', () => {
    expect(offersReconnect('connected')).toBe(false);
    expect(offersReconnect('connecting')).toBe(false);
    expect(offersReconnect('disconnected')).toBe(false);
  });
});
