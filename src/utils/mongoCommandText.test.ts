import { describe, expect, it } from 'vitest';
import { createCollectionCommand, dropCollectionCommand, shellString } from './mongoCommandText';

describe('mongoCommandText', () => {
  it('名字里的引号与反斜杠被转义，粘进 mongosh 还是同一个名字', () => {
    expect(shellString("it's")).toBe("'it\\'s'");
    expect(shellString('a\\b')).toBe("'a\\\\b'");
  });

  it('建集合：没有选项就只有名字', () => {
    expect(createCollectionCommand('shop', 'orders', '  ')).toBe("db.getSiblingDB('shop').createCollection('orders')");
    expect(createCollectionCommand('shop', 'log', '{ capped: true, size: 4096 }'))
      .toBe("db.getSiblingDB('shop').createCollection('log', { capped: true, size: 4096 })");
  });

  it('删集合按库与名字定位，名字带点也不会被当成子集合', () => {
    expect(dropCollectionCommand('shop', 'a.b')).toBe("db.getSiblingDB('shop').getCollection('a.b').drop()");
  });
});
