import { describe, expect, it } from 'vitest';
import { loadCatalogCodegenSchema } from './codegenCatalog';

describe('loadCatalogCodegenSchema', () => {
  it('reads every table with at most four queries in flight and keeps the order', async () => {
    let inFlight = 0;
    let peak = 0;
    const calls: unknown[][] = [];
    const select = async (sql: string, params: unknown[]) => {
      calls.push(params);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      const [name] = params as [string];
      return sql === 'columns'
        ? [{ column_name: `${name}_id`, data_type: 'integer', is_nullable: false, is_primary_key: true, primary_key_ordinal: 1 }]
        : [];
    };
    const tables = Array.from({ length: 9 }, (_, index) => ({ schema: 'public', name: `t${index}`, columns: [] }));
    const schema = await loadCatalogCodegenSchema(
      select,
      { columns: 'columns', indexes: 'indexes', parameter_count: 2 },
      'postgresql',
      tables,
      []
    );
    // 一张表两条查询（列与索引）一起发，四路并发就是最多八条在途
    expect(peak).toBeLessThanOrEqual(8);
    expect(calls).toContainEqual(['t3', 'public']);
    expect(schema.tables.map((table) => table.name)).toEqual(tables.map((table) => table.name));
    expect(schema.tables[8].primaryKey).toEqual(['t8_id']);
  });
});
