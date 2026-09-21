import { describe, expect, it } from 'vitest';
import { redactSqlForHistory } from './historyRedaction';

describe('redactSqlForHistory', () => {
  it('打掉 MySQL 的 IDENTIFIED BY，连带中间的插件名', () => {
    expect(
      redactSqlForHistory("CREATE USER 'app'@'%' IDENTIFIED BY 'hunter2'").sql
    ).toBe("CREATE USER 'app'@'%' IDENTIFIED BY '***'");
    expect(
      redactSqlForHistory(
        "ALTER USER 'app'@'%' IDENTIFIED WITH caching_sha2_password BY 'hunter2'"
      ).sql
    ).toBe("ALTER USER 'app'@'%' IDENTIFIED WITH caching_sha2_password BY '***'");
  });

  it('打掉 PostgreSQL 的 PASSWORD，不管带不带 ENCRYPTED 和等号', () => {
    expect(redactSqlForHistory("CREATE ROLE app LOGIN PASSWORD 'hunter2'").sql).toBe(
      "CREATE ROLE app LOGIN PASSWORD '***'"
    );
    expect(redactSqlForHistory("ALTER ROLE app ENCRYPTED PASSWORD 'hunter2'").sql).toBe(
      "ALTER ROLE app ENCRYPTED PASSWORD '***'"
    );
    expect(redactSqlForHistory("SET PASSWORD = 'hunter2'").sql).toBe("SET PASSWORD = '***'");
  });

  it('打掉按敏感列名赋的值，列名带引号也认', () => {
    expect(redactSqlForHistory("UPDATE users SET password = 'hunter2' WHERE id = 1").sql).toBe(
      "UPDATE users SET password = '***' WHERE id = 1"
    );
    expect(redactSqlForHistory('UPDATE t SET `api_key` = \'sk-live-abc\'').sql).toBe(
      "UPDATE t SET `api_key` = '***'"
    );
  });

  it('按列的位置打掉 INSERT 的值，包括多组 VALUES', () => {
    expect(
      redactSqlForHistory(
        "INSERT INTO users (name, password, email) VALUES ('ann', 'hunter2', 'a@b.c'), ('bob', 'letmein', 'b@b.c')"
      ).sql
    ).toBe(
      "INSERT INTO users (name, password, email) VALUES ('ann', '***', 'a@b.c'), ('bob', '***', 'b@b.c')"
    );
  });

  it('值里有表达式时整组放弃，不按错位打码', () => {
    // 第二个字面量是 NOW() 的参数位而不是 password 列，打它等于既泄密又毁语句
    const sql = "INSERT INTO users (name, password, note) VALUES ('ann', md5('x'), 'hi')";
    expect(redactSqlForHistory(sql).sql).toBe(sql);
  });

  it('注释里的撇号不会把后面的字面量边界带偏', () => {
    const sql = "-- don't touch\nUPDATE t SET password = 'hunter2'";
    expect(redactSqlForHistory(sql).sql).toBe("-- don't touch\nUPDATE t SET password = '***'");
  });

  it('转义的引号不会提前结束字面量', () => {
    expect(redactSqlForHistory("UPDATE t SET password = 'it''s me'").sql).toBe(
      "UPDATE t SET password = '***'"
    );
    expect(redactSqlForHistory("UPDATE t SET password = 'it\\'s me'").sql).toBe(
      "UPDATE t SET password = '***'"
    );
  });

  it('打掉字面量里的连接串口令', () => {
    expect(
      redactSqlForHistory("INSERT INTO config (url) VALUES ('postgres://u:hunter2@db:5432/app')").sql
    ).toBe("INSERT INTO config (url) VALUES ('postgres://u:***@db:5432/app')");
  });

  it('普通语句一个字都不改', () => {
    for (const sql of [
      'SELECT * FROM users ORDER BY name',
      "SELECT * FROM orders WHERE status = 'paid'",
      "SELECT 'password' AS label",
      "UPDATE t SET note = 'password reset requested'"
    ]) {
      const result = redactSqlForHistory(sql);
      expect(result.sql).toBe(sql);
      expect(result.redacted).toBe(false);
    }
  });

  it('改过的语句会标出来，因为它不能原样重跑', () => {
    expect(redactSqlForHistory("CREATE ROLE app PASSWORD 'x'").redacted).toBe(true);
    expect(redactSqlForHistory('SELECT 1').redacted).toBe(false);
  });

  it('PostgreSQL 的函数体整段跳过，里面的撇号不影响外面', () => {
    const sql = "CREATE FUNCTION f() RETURNS text AS $$ SELECT 'it''s' $$ LANGUAGE sql";
    expect(redactSqlForHistory(sql).sql).toBe(sql);
  });
});
