---
name: dataomni
description: "Read the user's databases through DataOmni's command line: the connections they opened to agents, read-only SQL, schemas, a whole-database data dictionary, and MongoDB / Redis / Neo4j / Elasticsearch reads. Use it when a task needs data or structure from one of the user's databases."
---

# DataOmni command line

`dataomni cli <command>` reads the databases the user has configured in DataOmni. It never writes to
them. If `dataomni` is not on PATH, on macOS it is `/Applications/DataOmni.app/Contents/MacOS/dataomni`.

## What you can reach

Only connections the user set to "Command line & agent access: read-only" in DataOmni. Production
connections are never visible. You cannot change this from the command line, and no option widens
it: when a command says a connection is not found, ask the user to open it in DataOmni rather than
looking for another way in.

Credentials come from the user's keychain; never ask the user for a password.

## How to work

1. `dataomni cli connections` lists what is open, with each connection's type. Use the name or id.
2. Before writing SQL, read the structure:
   - `dataomni cli dictionary <connection>` prints a Markdown data dictionary of the whole database
     (tables, columns, types, primary and foreign keys). Use the names exactly as listed.
   - `dataomni cli schema <connection>` lists tables and views; `schema <connection> <table>` gives
     one table's columns, indexes and foreign keys; `dataomni cli ddl <connection> <table>` gives
     the definition the database itself keeps.
3. `dataomni cli query <connection> "<sql>"` runs one read-only statement. At most 200 rows come back
   unless you pass `--limit N` (up to 10000); `truncated: true` means there were more. Prefer
   aggregating in SQL over pulling many rows.
4. `dataomni cli explain <connection> "<sql>"` shows the plan without running the statement.
5. `dataomni cli export <connection> "<sql>" --out FILE` writes all rows to a new CSV or JSON file
   (`--format json`); `dataomni cli backup <connection> --out PATH` makes a backup the way DataOmni
   does.
6. `dataomni cli test <connection>` checks the connection; on failure `error.diagnosis` says whether
   the host resolved and the port answered.

Pass long statements on stdin with `-` in place of the SQL: `dataomni cli query db - < query.sql`.

Only one statement per call, and only reads: `SELECT`, `WITH` (without writes inside), `SHOW`,
`DESCRIBE`, `EXPLAIN` (never `ANALYZE`), `VALUES`, `TABLE`. Everything else is refused with exit 3.

## Other databases

Each has its own command; run it with no operation to see its usage.

- MongoDB: `dataomni cli mongo <connection> collections`, then `find`, `count`, `aggregate`,
  `explain`, `structure` on `<database>.<collection>`. Filters and pipelines use mongosh syntax
  (`{ status: "open", total: { $gt: 10 } }`); documents come back as relaxed Extended JSON.
  Pipelines with `$out` or `$merge` are refused.
- Redis: `dataomni cli redis <connection> keyspaces`, `scan [<pattern>]`, `get <key>`, and
  `command <name> [<argument>...]` for any command the server flags readonly. Put `--db N` before
  the operation.
- Neo4j: `dataomni cli neo4j <connection> labels` and `run "<cypher>"`; only queries the server
  classifies as reads run.
- Elasticsearch / OpenSearch: `dataomni cli es <connection> indices` and
  `request <METHOD> <path> [<body>]` — `GET`, or `POST` to search endpoints such as `_search`,
  `_count`, `_msearch`.
- A local CSV file: `dataomni cli csv-preview <file>` sniffs its delimiter and encoding.

## Output and exit codes

Results are JSON on stdout with `"schema": 1` (`dictionary` prints Markdown). Errors are JSON on
stderr: `{"error": {"kind": "...", "message": "..."}}`.

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | ok | |
| 1 | the database reported an error, or a timeout | read the message; fix the statement |
| 2 | usage error, or no such connection / table | fix the arguments; a missing connection is not open to you |
| 3 | refused by the access rules | do not retry another way; this is a write or something the command line never does |
| 4 | unavailable: cannot connect, missing credentials, keychain waiting | tell the user; with kind `keychain`, they should click "Always Allow" in the prompt |

Every call is logged (command, connection, a hash of the statement, result) in DataOmni's log
directory; the statement text itself is not logged.
