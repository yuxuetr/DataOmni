import { describe, expect, it } from 'vitest';
import { DatabaseType } from '../contracts/connection';
import {
  REDIS_CLUSTER,
  REDIS_MODE_OPTION,
  REDIS_SENTINEL,
  REDIS_SENTINEL_MASTER_OPTION,
  redisMode,
  withRedisMode,
  withRedisSentinelMaster
} from './redisConnection';

describe('Redis 的部署方式', () => {
  it('只有 Redis 认这个选项，认不出的当单机', () => {
    expect(redisMode({ db_type: DatabaseType.Redis, options: { [REDIS_MODE_OPTION]: REDIS_SENTINEL } })).toBe('sentinel');
    expect(redisMode({ db_type: DatabaseType.Redis, options: { [REDIS_MODE_OPTION]: REDIS_CLUSTER } })).toBe('cluster');
    expect(redisMode({ db_type: DatabaseType.MongoDB, options: { [REDIS_MODE_OPTION]: REDIS_SENTINEL } })).toBe('standalone');
    expect(redisMode({ db_type: DatabaseType.Redis, options: { [REDIS_MODE_OPTION]: 'other' } })).toBe('standalone');
    expect(redisMode({ db_type: DatabaseType.Redis, options: {} })).toBe('standalone');
  });

  // 端口只换没改过的默认值：哨兵默认 26379、数据节点默认 6379，填过别的就留着
  it('换到 Sentinel 时默认端口换成哨兵的，换走时换回去；填过的端口不动', () => {
    expect(withRedisMode({ options: { other: 'x' }, port: 6379 }, 'sentinel')).toEqual({
      options: { other: 'x', [REDIS_MODE_OPTION]: REDIS_SENTINEL },
      port: 26379
    });
    expect(withRedisMode({ options: {}, port: 7000 }, 'sentinel').port).toBe(7000);
    expect(withRedisMode({ options: { [REDIS_MODE_OPTION]: REDIS_SENTINEL }, port: 26379 }, 'standalone')).toEqual({
      options: {},
      port: 6379
    });
    expect(withRedisMode({ options: { [REDIS_MODE_OPTION]: REDIS_SENTINEL }, port: 26379 }, 'cluster').port).toBe(6379);
    expect(withRedisMode({ options: {}, port: 7000 }, 'standalone').port).toBe(7000);
  });

  // 集群只有 0 号库
  it('换到集群时库号改成 0，别的方式不动库号', () => {
    expect(withRedisMode({ options: {}, port: 7000, database: '3' }, 'cluster')).toEqual({
      options: { [REDIS_MODE_OPTION]: REDIS_CLUSTER },
      port: 7000,
      database: '0'
    });
    expect(withRedisMode({ options: {}, port: 6379, database: '3' }, 'sentinel')).not.toHaveProperty('database');
  });

  // 主节点名不随方式丢：来回切一次不该把填好的名字清掉；别的方式下它不起作用
  it('换走时主节点名留着', () => {
    const options = { [REDIS_MODE_OPTION]: REDIS_SENTINEL, [REDIS_SENTINEL_MASTER_OPTION]: 'mymaster' };
    expect(withRedisMode({ options, port: 26379 }, 'standalone').options).toEqual({
      [REDIS_SENTINEL_MASTER_OPTION]: 'mymaster'
    });
  });

  it('改主节点名只动那一项，清空就去掉', () => {
    expect(withRedisSentinelMaster({ a: '1' }, 'mymaster')).toEqual({ a: '1', [REDIS_SENTINEL_MASTER_OPTION]: 'mymaster' });
    expect(withRedisSentinelMaster({ a: '1', [REDIS_SENTINEL_MASTER_OPTION]: 'm' }, '')).toEqual({ a: '1' });
  });
});
