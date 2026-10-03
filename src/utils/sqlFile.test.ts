import { describe, expect, it } from 'vitest';
import {
  linkSqlFile,
  planSqlSave,
  readSqlFileText,
  savedToFile,
  sqlFileContents,
  stripBom,
  suggestSqlFileName,
  tabTitleFromSqlPath
} from './sqlFile';

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

describe('就地保存', () => {
  const link = linkSqlFile('/work/report.sql', 'SELECT 1');

  it('没有来源文件时要选路径', () => {
    expect(planSqlSave(undefined, null)).toBe('choose-path');
  });

  it('磁盘上还是上次读写时的内容，直接写', () => {
    expect(planSqlSave(link, 'SELECT 1')).toBe('write');
    // 带 BOM 的文件读进来时 BOM 已经去掉了，比的也是去掉之后的
    expect(planSqlSave(link, '\ufeffSELECT 1')).toBe('write');
  });

  it('被别的程序改过或删掉了，先问', () => {
    expect(planSqlSave(link, 'SELECT 2')).toBe('confirm-overwrite');
    expect(planSqlSave(link, null)).toBe('confirm-overwrite');
  });

  it('内容与上次存下的一致才算已保存', () => {
    expect(savedToFile(link, 'SELECT 1')).toBe(true);
    expect(savedToFile(link, 'SELECT 1 ')).toBe(false);
    expect(savedToFile(undefined, 'SELECT 1')).toBe(false);
  });
});

describe('Windows 换行（CRLF）的脚本', () => {
  const disk = '\ufeffSELECT 1;\r\n-- 清掉测试数据\r\nDELETE FROM t WHERE id = 1;\r\n';

  it('读进编辑器时换行统一成 \\n：编辑器的位置和文本得对得上', () => {
    // CodeMirror 把 CRLF 读成一个换行。文本里留着 \r 的话，按编辑器的位置去截
    // 「选中的那段」，每多一行就往前偏一个字符
    const { text } = readSqlFileText(disk);
    expect(text).toBe('SELECT 1;\n-- 清掉测试数据\nDELETE FROM t WHERE id = 1;\n');
    expect(readSqlFileText('SELECT 1;\rSELECT 2;').text).toBe('SELECT 1;\nSELECT 2;');
  });

  it('存回去还是 CRLF、还带 BOM，不悄悄改掉别人仓库里的文件', () => {
    const { text, link } = readSqlFileText(disk, '/work/cleanup.sql');
    expect(sqlFileContents(`${text}SELECT 2;\n`, link)).toBe(
      '\ufeffSELECT 1;\r\n-- 清掉测试数据\r\nDELETE FROM t WHERE id = 1;\r\nSELECT 2;\r\n'
    );
    // 两样各管各的：只有 BOM 的照 `\n` 写，只有 CRLF 的不加 BOM
    const bomOnly = readSqlFileText('\ufeffSELECT 1;\n', '/work/bom.sql');
    expect(sqlFileContents(bomOnly.text, bomOnly.link)).toBe('\ufeffSELECT 1;\n');
    const crlfOnly = readSqlFileText('SELECT 1;\r\n', '/work/crlf.sql');
    expect(sqlFileContents(crlfOnly.text, crlfOnly.link)).toBe('SELECT 1;\r\n');
    // 存过一次之后再存，格式还跟着原文件
    const resaved = linkSqlFile(link.path, text, link);
    expect(sqlFileContents(text, resaved)).toBe(disk);
    expect(sqlFileContents('SELECT 1;\n', linkSqlFile('/work/new.sql', 'SELECT 1;\n'))).toBe('SELECT 1;\n');
    expect(sqlFileContents('SELECT 1;\n', undefined)).toBe('SELECT 1;\n');
  });

  it('刚打开就是已保存；磁盘上没动过就直接写', () => {
    const { text, link } = readSqlFileText(disk, '/work/cleanup.sql');
    expect(savedToFile(link, text)).toBe(true);
    expect(planSqlSave(link, disk)).toBe('write');
    expect(planSqlSave(link, disk.replace('id = 1', 'id = 2'))).toBe('confirm-overwrite');
  });
});
