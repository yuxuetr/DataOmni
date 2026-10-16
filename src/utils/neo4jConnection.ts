import { DatabaseType, type ConnectionConfig } from '../contracts/connection';

/** 与后端 `NEO4J_ROUTING_OPTION` 一致：`options` 里这一项为 `"true"` 就按集群路由连（`neo4j://`） */
export const NEO4J_ROUTING_OPTION = 'neo4jRouting';

export function isNeo4jRouting(config: Partial<Pick<ConnectionConfig, 'db_type' | 'options'>>): boolean {
  return config.db_type === DatabaseType.Neo4j && config.options?.[NEO4J_ROUTING_OPTION] === 'true';
}

export function withNeo4jRouting(
  options: Record<string, string> | undefined,
  enabled: boolean
): Record<string, string> {
  const rest = Object.fromEntries(
    Object.entries(options ?? {}).filter(([name]) => name !== NEO4J_ROUTING_OPTION)
  );
  return enabled ? { ...rest, [NEO4J_ROUTING_OPTION]: 'true' } : rest;
}
