import { describe, expect, it } from 'vitest';
import { stripBom, suggestSqlFileName, tabTitleFromSqlPath } from './sqlFile';

describe('stripBom', () => {
  it('去掉开头的 BOM', () => {
    expect(stripBom('\ufeffSELECT 1')).toBe('SELECT 1');
  });

  it('不动没有 BOM 的文本', () => {
    expect(stripBom('SELECT 1')).toBe('SELECT 1');
    expect(stripBom('')).toBe('');
  });

  it('只去开头那一个，不碰正文里的', () => {
    // 正文里的零宽不换行空格是用户自己写进字符串的内容，删掉就是改了他的语句
    expect(stripBom("\ufeffSELECT '\ufeff'")).toBe("SELECT '\ufeff'");
  });
});

describe('suggestSqlFileName', () => {
  it('补上 .sql 后缀', () => {
    expect(suggestSqlFileName('每日对账')).toBe('每日对账.sql');
  });

  it('已经有后缀就不重复加，且不区分大小写', () => {
    expect(suggestSqlFileName('report.sql')).toBe('report.sql');
    expect(suggestSqlFileName('report.SQL')).toBe('report.SQL');
  });

  it('换掉文件名里非法的字符', () => {
    // `public/orders` 原样传给保存对话框，在某些平台上会被当成路径分隔符
    expect(suggestSqlFileName('public/orders')).toBe('public orders.sql');
    expect(suggestSqlFileName('a:b*c?d"e<f>g|h')).toBe('a b c d e f g h.sql');
    expect(suggestSqlFileName('两\n行')).toBe('两 行.sql');
  });

  it('清干净之后什么都不剩时用一个兜底名字', () => {
    expect(suggestSqlFileName('   ')).toBe('query.sql');
    expect(suggestSqlFileName('///')).toBe('query.sql');
    expect(suggestSqlFileName('..')).toBe('query.sql');
  });
});

describe('tabTitleFromSqlPath', () => {
  it('取文件名并去掉后缀', () => {
    expect(tabTitleFromSqlPath('/Users/me/scripts/每日对账.sql')).toBe('每日对账');
    expect(tabTitleFromSqlPath('C:\\scripts\\report.SQL')).toBe('report');
  });

  it('没有后缀时原样用文件名', () => {
    expect(tabTitleFromSqlPath('/tmp/scratch')).toBe('scratch');
  });
});
