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

  it('打掉 Oracle 的 IDENTIFIED BY：口令是标识符，可以不带引号或带双引号', () => {
    expect(redact('CREATE USER app IDENTIFIED BY tiger', 'oracle').sql).toBe("CREATE USER app IDENTIFIED BY '***'");
    expect(redact('ALTER USER app IDENTIFIED BY "N3w#pw" REPLACE "0ld#pw"', 'oracle').sql).toBe(
      "ALTER USER app IDENTIFIED BY '***' REPLACE '***'"
    );
    expect(
      redact("CREATE DATABASE LINK l CONNECT TO scott IDENTIFIED BY tiger USING 'orcl'", 'oracle').sql
    ).toBe("CREATE DATABASE LINK l CONNECT TO scott IDENTIFIED BY '***' USING 'orcl'");
    // 别的库里口令只能是字符串，不带引号的那个词不是口令
    expect(redact('CREATE USER app IDENTIFIED BY tiger').redacted).toBe(false);
  });

  it('改口令时一并给出的旧口令也打', () => {
    expect(redact("ALTER USER app IDENTIFIED BY 'new' REPLACE 'old'").sql).toBe(
      "ALTER USER app IDENTIFIED BY '***' REPLACE '***'"
    );
    expect(redact("ALTER LOGIN app WITH PASSWORD = 'new1' OLD_PASSWORD = 'old1'", 'sqlserver').sql).toBe(
      "ALTER LOGIN app WITH PASSWORD = '***' OLD_PASSWORD = '***'"
    );
  });

  it('MySQL 的 SET PASSWORD 带 FOR 用户、带 REPLACE 旧口令时也打', () => {
    expect(redact("SET PASSWORD FOR 'app'@'%' = 'hunter2'").sql).toBe("SET PASSWORD FOR 'app'@'%' = '***'");
    expect(redact('SET PASSWORD FOR app = \'hunter2\'').sql).toBe("SET PASSWORD FOR app = '***'");
    expect(redact("SET PASSWORD = 'new' REPLACE 'old'").sql).toBe("SET PASSWORD = '***' REPLACE '***'");
    expect(redact("SET PASSWORD FOR 'app'@'%' = 'new' REPLACE 'old' RETAIN CURRENT PASSWORD").sql).toBe(
      "SET PASSWORD FOR 'app'@'%' = '***' REPLACE '***' RETAIN CURRENT PASSWORD"
    );
    // 用户名与主机名不是口令
    expect(redact("SET PASSWORD FOR 'app'@'%' = 'x'").sql).toContain("'app'@'%'");
  });

  it("字面量带前缀时照样打：SQL Server 的 N'…'、PostgreSQL 的 E'…'、MySQL 的字符集引导", () => {
    // SSMS 生成的脚本里字符串都写成 N'…'
    expect(redact("ALTER LOGIN app WITH PASSWORD = N'new1' OLD_PASSWORD = N'old1'", 'sqlserver').sql).toBe(
      "ALTER LOGIN app WITH PASSWORD = N'***' OLD_PASSWORD = N'***'"
    );
    expect(redact("ALTER ROLE app PASSWORD E'it\\'s'", 'postgresql').sql).toBe("ALTER ROLE app PASSWORD E'***'");
    expect(redact("SET PASSWORD = _utf8mb4'hunter2'").sql).toBe("SET PASSWORD = _utf8mb4'***'");
    // 词尾恰好是 N / E 的关键字不是前缀
    expect(redact("SELECT CASE WHEN 'a' = 'b' THEN 1 END").redacted).toBe(false);
  });

  it('打掉带前缀的口令选项与列名：复制源的 SOURCE_PASSWORD、user_password', () => {
    expect(redact("CHANGE REPLICATION SOURCE TO SOURCE_USER='r', SOURCE_PASSWORD='s3cret'").sql).toBe(
      "CHANGE REPLICATION SOURCE TO SOURCE_USER='r', SOURCE_PASSWORD='***'"
    );
    expect(redact("CHANGE MASTER TO MASTER_PASSWORD='s3cret'").sql).toBe("CHANGE MASTER TO MASTER_PASSWORD='***'");
    expect(redact("UPDATE users SET user_password = 'x' WHERE id = 1").sql).toBe(
      "UPDATE users SET user_password = '***' WHERE id = 1"
    );
  });

  it('打掉 DuckDB 的 CREATE SECRET 与 ClickHouse 命名集合里的密钥', () => {
    expect(
      redact("CREATE SECRET s (TYPE s3, KEY_ID 'AKIAEXAMPLE', SECRET 'wJalr', REGION 'us-east-1')", 'duckdb').sql
    ).toBe("CREATE SECRET s (TYPE s3, KEY_ID 'AKIAEXAMPLE', SECRET '***', REGION 'us-east-1')");
    expect(redact("CREATE PERSISTENT SECRET h (TYPE http, BEARER_TOKEN 'tok')", 'duckdb').sql).toBe(
      "CREATE PERSISTENT SECRET h (TYPE http, BEARER_TOKEN '***')"
    );
    expect(redact("CREATE SECRET a (TYPE azure, CONNECTION_STRING 'AccountName=a;AccountKey=k')", 'duckdb').sql).toBe(
      "CREATE SECRET a (TYPE azure, CONNECTION_STRING '***')"
    );
    expect(
      redact("CREATE NAMED COLLECTION c AS access_key_id = 'id', secret_access_key = 'k'", 'clickhouse').sql
    ).toBe("CREATE NAMED COLLECTION c AS access_key_id = 'id', secret_access_key = '***'");
    // 选项清单之外，词后面跟个字面量不算
    expect(redact("SELECT 'x' AS secret, 'y'", 'duckdb').redacted).toBe(false);
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

  it('打掉键值对写法的连接串口令：libpq 的 password=、ODBC / ADO 的 Pwd=', () => {
    // DuckDB 挂 PostgreSQL / MySQL 库、PostgreSQL 的 dblink 都用 libpq 的写法
    expect(redact("ATTACH 'host=db user=u password=hunter2 dbname=app' AS p (TYPE postgres)", 'duckdb').sql).toBe(
      "ATTACH 'host=db user=u password=*** dbname=app' AS p (TYPE postgres)"
    );
    expect(redact("SELECT * FROM dblink('host=db password = hunter2', 'SELECT 1') AS t(a int)", 'postgresql').sql).toBe(
      "SELECT * FROM dblink('host=db password = ***', 'SELECT 1') AS t(a int)"
    );
    // libpq 的值可以用单引号包着，写进 SQL 字面量里是两个单引号
    expect(redact("ATTACH 'host=db password=''a b'' dbname=app' AS p (TYPE postgres)", 'duckdb').sql).toBe(
      "ATTACH 'host=db password=*** dbname=app' AS p (TYPE postgres)"
    );
    expect(
      redact("SELECT * FROM OPENROWSET('MSOLEDBSQL', 'Server=s;Uid=u;Pwd=hunter2;', 'SELECT 1')", 'sqlserver').sql
    ).toBe("SELECT * FROM OPENROWSET('MSOLEDBSQL', 'Server=s;Uid=u;Pwd=***;', 'SELECT 1')");
    expect(redact("SELECT 'Server=s;Password={a;b};Database=d'", 'sqlserver').sql).toBe(
      "SELECT 'Server=s;Password=***;Database=d'"
    );
    // 字面量外面的 pwd = 列是比较，不是连接串
    expect(redact('SELECT * FROM t WHERE pwd = other_col').redacted).toBe(false);
    expect(redact("SELECT 'password reset requested'").redacted).toBe(false);
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

  it('1MB 的一条语句也是线性时间：mysqldump 的扩展 INSERT 每条就这么长', () => {
    // 连接串那条正则曾在一长串字母的每个位置都重新起头往后扫，是平方级：
    // 8 万字符要 4 秒，1MB 一条要十分钟上下，执行完记历史时整个界面卡死。
    // 线性实现在这里是几毫秒，平方级是几分钟，2 秒的门两边都离得很远
    const value = 'x'.repeat(1_000_000);
    const sql = `INSERT INTO t VALUES ('${value}', 'postgres://u:hunter2@db/app');`;
    const startedAt = performance.now();
    const { sql: redacted } = redact(sql);
    expect(performance.now() - startedAt).toBeLessThan(2000);
    expect(redacted).toBe(`INSERT INTO t VALUES ('${value}', 'postgres://u:***@db/app');`);
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
    // redis-cli 在参数中间遇到引号也开始引用：`>"my pass"` 是一个参数 `>my pass`，后半截不能漏出来
    expect(redis('ACL SETUSER app >"my pass" on')).toBe('ACL SETUSER app >*** on');
    expect(redis("ACL SETUSER app >'my pass' on")).toBe('ACL SETUSER app >*** on');
    expect(redis('AUTH reader x"y z"')).toBe('AUTH reader ***');
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
