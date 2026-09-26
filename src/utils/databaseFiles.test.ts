import { describe, expect, it } from 'vitest';
import { DatabaseType } from '../contracts/connection';
import { connectionNameFromFile, databaseTypeOfFile, isFileDatabase } from './databaseFiles';

describe('databaseFiles', () => {
  it('tells DuckDB files from SQLite ones by extension', () => {
    expect(databaseTypeOfFile('/data/events.duckdb')).toBe(DatabaseType.DuckDB);
    expect(databaseTypeOfFile('C:\\data\\EVENTS.DDB')).toBe(DatabaseType.DuckDB);
    expect(databaseTypeOfFile('/data/app.sqlite3')).toBe(DatabaseType.SQLite);
    // `.db` 两家都用，归 SQLite；没有扩展名的也是
    expect(databaseTypeOfFile('/data/app.db')).toBe(DatabaseType.SQLite);
    expect(databaseTypeOfFile('/data/.duckdb/app')).toBe(DatabaseType.SQLite);
  });

  it('names the connection after the file without a known extension', () => {
    expect(connectionNameFromFile('/data/events.duckdb')).toBe('events');
    expect(connectionNameFromFile('/data/app.v2.sqlite')).toBe('app.v2');
    expect(connectionNameFromFile('/data/notes.txt')).toBe('notes.txt');
    expect(connectionNameFromFile('/data/.duckdb')).toBe('.duckdb');
  });

  it('only SQLite and DuckDB are files', () => {
    expect(isFileDatabase(DatabaseType.DuckDB)).toBe(true);
    expect(isFileDatabase(DatabaseType.SQLite)).toBe(true);
    expect(isFileDatabase(DatabaseType.PostgreSQL)).toBe(false);
  });
});
