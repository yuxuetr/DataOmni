import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildDataDictionary, type DictionarySource } from './dataDictionary';
import { translate } from '../i18n/translate';

/**
 * 数据字典有两份实现：这里是界面导出，`src-tauri/src/cli/dictionary.rs` 是命令行的 `dictionary`。
 * 命令行只出英文，所以这边用英文目录核对；两边对同一份输入要逐字相同
 */
interface Case extends Omit<DictionarySource, 'origin'> {
  why: string;
  expected: string;
}

const CORPUS_PATH = new URL('../../fixtures/dictionary-conformance.json', import.meta.url);
const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as { cases: Case[] };

describe('数据字典共用语料', () => {
  it.each(corpus.cases.map((testCase) => [testCase.why, testCase] as const))('%s', (_why, testCase) => {
    const text = buildDataDictionary({ ...testCase, origin: 'catalog' }, (key, params) => translate('en', key, params));
    expect(text).toBe(testCase.expected);
  });
});
