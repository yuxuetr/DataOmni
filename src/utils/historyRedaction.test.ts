import { describe, expect, it } from 'vitest';
import type { SqlDialect } from '../contracts/queryExecution';
import { redactConsoleForHistory, redactSqlForHistory } from './historyRedaction';

const redact = (sql: string, dialect: SqlDialect = 'mysql') => redactSqlForHistory(sql, dialect);

describe('redactSqlForHistory', () => {
  it('打掉 MySQL 的 IDENTIFIED BY，连带中间的插件名', () => {
    expect(
      redact("CREATE USER 'app'@'%' IDENTIFIED BY 'hunter2'").sql
    ).toBe("CREATE USER 'app'@'%' IDENTIFIED BY '***'");
    expect(
      redact(
        "ALTER USER 'app'@'%' IDENTIFIED WITH caching_sha2_password BY 'hunter2'"
      ).sql
    ).toBe("ALTER USER 'app'@'%' IDENTIFIED WITH caching_sha2_password BY '***'");
  });

  it('打掉 PostgreSQL 的 PASSWORD，不管带不带 ENCRYPTED 和等号', () => {
    expect(redact("CREATE ROLE app LOGIN PASSWORD 'hunter2'", 'postgresql').sql).toBe(
      "CREATE ROLE app LOGIN PASSWORD '***'"
    );
    expect(redact("ALTER ROLE app ENCRYPTED PASSWORD 'hunter2'", 'postgresql').sql).toBe(
      "ALTER ROLE app ENCRYPTED PASSWORD '***'"
    );
    expect(redact("SET PASSWORD = 'hunter2'").sql).toBe("SET PASSWORD = '***'");
  });

  it('打掉按敏感列名赋的值，列名带引号也认', () => {
    expect(redact("UPDATE users SET password = 'hunter2' WHERE id = 1").sql).toBe(
      "UPDATE users SET password = '***' WHERE id = 1"
    );
    expect(redact('UPDATE t SET `api_key` = \'sk-live-abc\'').sql).toBe(
      "UPDATE t SET `api_key` = '***'"
    );
  });

  it('按列的位置打掉 INSERT 的值，包括多组 VALUES', () => {
    expect(
      redact(
        "INSERT INTO users (name, password, email) VALUES ('ann', 'hunter2', 'a@b.c'), ('bob', 'letmein', 'b@b.c')"
      ).sql
    ).toBe(
      "INSERT INTO users (name, password, email) VALUES ('ann', '***', 'a@b.c'), ('bob', '***', 'b@b.c')"
    );
  });

  it('值里有表达式时整组放弃，不按错位打码', () => {
    // 第二个字面量是 NOW() 的参数位而不是 password 列，打它等于既泄密又毁语句
    const sql = "INSERT INTO users (name, password, note) VALUES ('ann', md5('x'), 'hi')";
    expect(redact(sql, 'postgresql').sql).toBe(sql);
  });

  it('注释里的撇号不会把后面的字面量边界带偏', () => {
    const sql = "-- don't touch\nUPDATE t SET password = 'hunter2'";
    expect(redact(sql).sql).toBe("-- don't touch\nUPDATE t SET password = '***'");
  });

  it('转义的引号不会提前结束字面量', () => {
    expect(redact("UPDATE t SET password = 'it''s me'").sql).toBe(
      "UPDATE t SET password = '***'"
    );
    expect(redact("UPDATE t SET password = 'it\\'s me'").sql).toBe(
      "UPDATE t SET password = '***'"
    );
  });

  it('打掉字面量里的连接串口令', () => {
    expect(
      redact("INSERT INTO config (url) VALUES ('postgres://u:hunter2@db:5432/app')").sql
    ).toBe("INSERT INTO config (url) VALUES ('postgres://u:***@db:5432/app')");
  });

  it('普通语句一个字都不改', () => {
    for (const sql of [
      'SELECT * FROM users ORDER BY name',
      "SELECT * FROM orders WHERE status = 'paid'",
      "SELECT 'password' AS label",
      "UPDATE t SET note = 'password reset requested'"
    ]) {
      const result = redact(sql);
      expect(result.sql).toBe(sql);
      expect(result.redacted).toBe(false);
    }
  });

  it('改过的语句会标出来，因为它不能原样重跑', () => {
    expect(redact("CREATE ROLE app PASSWORD 'x'").redacted).toBe(true);
    expect(redact('SELECT 1').redacted).toBe(false);
  });

  it('PostgreSQL 的函数体整段跳过，里面的撇号不影响外面', () => {
    const sql = "CREATE FUNCTION f() RETURNS text AS $$ SELECT 'it''s' $$ LANGUAGE sql";
    expect(redact(sql, 'postgresql').sql).toBe(sql);
  });

  it('反斜杠只在 MySQL 里是转义符', () => {
    // PostgreSQL 里 'C:\' 到第二个撇号就结束了。按 MySQL 算会把 `\'` 当成转义，
    // 字面量一路吞到 password 的开引号，口令本身落在「字面量外面」而漏掉
    const sql = "UPDATE users SET home = 'C:\\', password = 'hunter2'";
    for (const dialect of ['postgresql', 'sqlite', 'sqlserver', 'oracle', 'duckdb'] as const) {
      expect(redact(sql, dialect).sql, dialect).toBe("UPDATE users SET home = 'C:\\', password = '***'");
    }
    for (const dialect of ['mysql', 'clickhouse'] as const) {
      expect(redact("UPDATE t SET note = 'it\\'s', password = 'hunter2'", dialect).sql, dialect).toBe(
        "UPDATE t SET note = 'it\\'s', password = '***'"
      );
    }
  });

  it("PostgreSQL 与 DuckDB 的 E'…' 里反斜杠照样转义", () => {
    for (const dialect of ['postgresql', 'duckdb'] as const) {
      expect(redact("UPDATE t SET note = E'it\\'s', password = 'hunter2'", dialect).sql, dialect).toBe(
        "UPDATE t SET note = E'it\\'s', password = '***'"
      );
    }
  });

  it('# 只在 MySQL 里是注释', () => {
    // SQL Server 的临时表就叫 #tmp；当成注释会把同一行后面的口令一起跳过
    expect(redact("SELECT * INTO #tmp FROM t; ALTER LOGIN app WITH PASSWORD = 'hunter2'", 'sqlserver').sql).toBe(
      "SELECT * INTO #tmp FROM t; ALTER LOGIN app WITH PASSWORD = '***'"
    );
    const commented = "# UPDATE t SET password = 'old'\nSELECT 1";
    expect(redact(commented, 'mysql').sql).toBe(commented);
    // ClickHouse 也认 `#` 注释（25.8 上试过）
    expect(redact(commented, 'clickhouse').sql).toBe(commented);
  });
});

describe('redactConsoleForHistory', () => {
  it('打掉 Cypher 的口令，改自己口令时新旧两个都打', () => {
    expect(redactConsoleForHistory('cypher', "CREATE USER jake SET PASSWORD 'abc123' CHANGE NOT REQUIRED").sql)
      .toBe("CREATE USER jake SET PASSWORD '***' CHANGE NOT REQUIRED");
    expect(redactConsoleForHistory('cypher', 'ALTER CURRENT USER SET PASSWORD FROM "old" TO \'new\'').sql)
      .toBe("ALTER CURRENT USER SET PASSWORD FROM '***' TO '***'");
    expect(redactConsoleForHistory('cypher', "CREATE (:Account {name: 'a', api_key: 'sk-1'})").sql)
      .toBe("CREATE (:Account {name: 'a', api_key: '***'})");
    expect(redactConsoleForHistory('cypher', "MATCH (u) SET u.password = 'x' RETURN u").sql)
      .toBe("MATCH (u) SET u.password = '***' RETURN u");
    // 普通的查询原样
    const plain = "MATCH (n:Person {name: 'token ring'}) RETURN n";
    expect(redactConsoleForHistory('cypher', plain)).toEqual({ sql: plain, redacted: false });
  });

  it('打掉 Elasticsearch 请求体与查询串里按名字认出的口令', () => {
    const request = 'PUT /_security/user/app\n{ "password" : "hunter2", "roles": ["r"], "metadata": { "client_secret": "s\\"x" } }';
    const result = redactConsoleForHistory('elasticsearch', request);
    expect(result.sql).toBe('PUT /_security/user/app\n{ "password" : "***", "roles": ["r"], "metadata": { "client_secret": "***" } }');
    expect(result.redacted).toBe(true);
    expect(redactConsoleForHistory('elasticsearch', 'GET /x/_search?api_key=abc&size=1').sql).toBe('GET /x/_search?api_key=***&size=1');
    expect(redactConsoleForHistory('elasticsearch', 'GET /books/_search\n{ "query": { "match": { "title": "password" } } }').redacted).toBe(false);
  });

  it('按参数打掉 Redis 命令里的口令', () => {
    const redis = (line: string) => redactConsoleForHistory('redis', line).sql;
    expect(redis('AUTH hunter2')).toBe('AUTH ***');
    expect(redis('auth reader "p w"')).toBe('auth reader ***');
    expect(redis('HELLO 3 AUTH default hunter2 SETNAME x')).toBe('HELLO 3 AUTH default *** SETNAME x');
    expect(redis('MIGRATE h 6379 k 0 5000 AUTH2 u pw KEYS a')).toBe('MIGRATE h 6379 k 0 5000 AUTH2 u *** KEYS a');
    expect(redis('CONFIG SET requirepass s3cret maxmemory 1gb')).toBe('CONFIG SET requirepass *** maxmemory 1gb');
    expect(redis('ACL SETUSER app on >pw1 <old ~cache:* +get')).toBe('ACL SETUSER app on >*** <*** ~cache:* +get');
    expect(redactConsoleForHistory('redis', 'GET password')).toEqual({ sql: 'GET password', redacted: false });
  });

  it('打掉 MongoDB 命令里按键名认出的口令，键带不带引号都认', () => {
    expect(redactConsoleForHistory('mongodb', "{ createUser: 'app', pwd: 'hunter2', roles: [] }").sql)
      .toBe("{ createUser: 'app', pwd: '***', roles: [] }");
    expect(redactConsoleForHistory('mongodb', '{ "updateUser": "app", "pwd": "hunter2" }').sql)
      .toBe('{ "updateUser": "app", "pwd": \'***\' }');
    const plain = "{ find: 'users', filter: { name: 'pwd' } }";
    expect(redactConsoleForHistory('mongodb', plain)).toEqual({ sql: plain, redacted: false });
  });

  it('三种都打掉连接串里的口令', () => {
    expect(redactConsoleForHistory('cypher', "LOAD CSV FROM 'https://u:pw@h/x.csv' AS row RETURN row").sql)
      .toBe("LOAD CSV FROM 'https://u:***@h/x.csv' AS row RETURN row");
  });
});
