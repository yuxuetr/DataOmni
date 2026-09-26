import { describe, expect, it } from 'vitest';
import { dropObjectSql, suggestIndexName, truncateTableSql } from './objectDdl';

describe('起手的索引名', () => {
  it('普通索引 idx_，唯一索引 uq_', () => {
    expect(suggestIndexName('orders', ['tenant_id', 'code'], false, 'postgresql'))
      .toBe('idx_orders_tenant_id_code');
    expect(suggestIndexName('orders', ['code'], true, 'mysql')).toBe('uq_orders_code');
  });

  it('Oracle 写成大写：带引号的小写名字以后每次都得加引号', () => {
    expect(suggestIndexName('ORDERS', ['CODE'], false, 'oracle')).toBe('IDX_ORDERS_CODE');
  });

  it('按字节截，不按字符截', () => {
    // 60 个字符的中文是 180 字节，PostgreSQL 会悄悄截到 63 字节
    const name = suggestIndexName('订单明细表', ['客户编号', '下单时间', '收货地址', '备注说明'], false, 'postgresql');
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(60);
    expect(name.startsWith('idx_订单明细表_')).toBe(true);
    // 截在字的边界上：没有被劈开的半个字
    expect(name).not.toContain('�');
  });
});

describe('ClickHouse 的删除与清空', () => {
  it('物化视图照视图删：它不认 DROP MATERIALIZED VIEW（25.8 上试过）', () => {
    expect(dropObjectSql({ schema: 'db', name: 'mv', kind: 'materialized-view' }, 'clickhouse'))
      .toBe('DROP VIEW `db`.`mv`');
    expect(dropObjectSql({ schema: 'db', name: 'mv', kind: 'materialized-view' }, 'postgresql'))
      .toBe('DROP MATERIALIZED VIEW "db"."mv"');
    expect(truncateTableSql({ schema: 'db', name: 't' }, 'clickhouse')).toBe('TRUNCATE TABLE `db`.`t`');
  });
});
