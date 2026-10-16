import { describe, expect, it } from 'vitest';
import { DatabaseType } from '../contracts/connection';
import { NEO4J_ROUTING_OPTION, isNeo4jRouting, withNeo4jRouting } from './neo4jConnection';

describe('Neo4j 按集群路由连接', () => {
  it('只有 Neo4j 认这个选项', () => {
    const options = { [NEO4J_ROUTING_OPTION]: 'true' };
    expect(isNeo4jRouting({ db_type: DatabaseType.Neo4j, options })).toBe(true);
    expect(isNeo4jRouting({ db_type: DatabaseType.MongoDB, options })).toBe(false);
    expect(isNeo4jRouting({ db_type: DatabaseType.Neo4j, options: {} })).toBe(false);
  });

  it('开关只动这一项', () => {
    expect(withNeo4jRouting({ other: 'x' }, true)).toEqual({ other: 'x', [NEO4J_ROUTING_OPTION]: 'true' });
    expect(withNeo4jRouting({ other: 'x', [NEO4J_ROUTING_OPTION]: 'true' }, false)).toEqual({ other: 'x' });
  });
});
