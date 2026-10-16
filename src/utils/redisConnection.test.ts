import { describe, expect, it } from 'vitest';
import { DatabaseType } from '../contracts/connection';
import {
  REDIS_MODE_OPTION,
  REDIS_SENTINEL,
  REDIS_SENTINEL_MASTER_OPTION,
  isRedisSentinel,
  withRedisSentinel,
  withRedisSentinelMaster
} from './redisConnection';

describe('Redis 经 Sentinel 连接', () => {
  it('只有 Redis 认这个选项', () => {
    const options = { [REDIS_MODE_OPTION]: REDIS_SENTINEL };
    expect(isRedisSentinel({ db_type: DatabaseType.Redis, options })).toBe(true);
    expect(isRedisSentinel({ db_type: DatabaseType.MongoDB, options })).toBe(false);
    expect(isRedisSentinel({ db_type: DatabaseType.Redis, options: {} })).toBe(false);
  });

  // 端口只换没改过的默认值：哨兵默认 26379、数据节点默认 6379，填过别的就留着
  it('切过去时默认端口换成哨兵的，切回来换回去；填过的端口不动', () => {
    expect(withRedisSentinel({ options: { other: 'x' }, port: 6379 }, true)).toEqual({
      options: { other: 'x', [REDIS_MODE_OPTION]: REDIS_SENTINEL },
      port: 26379
    });
    expect(withRedisSentinel({ options: {}, port: 7000 }, true).port).toBe(7000);
    expect(withRedisSentinel({ options: { [REDIS_MODE_OPTION]: REDIS_SENTINEL }, port: 26379 }, false)).toEqual({
      options: {},
      port: 6379
    });
    expect(withRedisSentinel({ options: {}, port: 7000 }, false).port).toBe(7000);
  });

  // 主节点名不随模式丢：来回切一次不该把填好的名字清掉；单机连接上它不起作用
  it('切回单机时主节点名留着', () => {
    const options = { [REDIS_MODE_OPTION]: REDIS_SENTINEL, [REDIS_SENTINEL_MASTER_OPTION]: 'mymaster' };
    expect(withRedisSentinel({ options, port: 26379 }, false).options).toEqual({
      [REDIS_SENTINEL_MASTER_OPTION]: 'mymaster'
    });
  });

  it('改主节点名只动那一项，清空就去掉', () => {
    expect(withRedisSentinelMaster({ a: '1' }, 'mymaster')).toEqual({ a: '1', [REDIS_SENTINEL_MASTER_OPTION]: 'mymaster' });
    expect(withRedisSentinelMaster({ a: '1', [REDIS_SENTINEL_MASTER_OPTION]: 'm' }, '')).toEqual({ a: '1' });
  });
});
