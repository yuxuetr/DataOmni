import { StreamLanguage, type Language } from '@codemirror/language';
import { StandardSQL } from '@codemirror/lang-sql';
import { cypher } from '@codemirror/legacy-modes/mode/cypher';
import { javascript, json } from '@codemirror/legacy-modes/mode/javascript';
import { classHighlighter, highlightCode } from '@lezer/highlight';

/**
 * 只读的代码块怎么上色：要执行的语句预览、DDL、结果里的 JSON。
 *
 * 用编辑器同一套词法器（lezer 的解析树），不开编辑器——一个确认框里摆一个 CodeMirror
 * 太重，而这里只要颜色。切出来的片段拼回去就是原文，一个字不改，所以复制出去的也还是原文。
 */

export type CodeLanguage = 'sql' | 'json' | 'javascript' | 'cypher';

/** 只给这几类上色；变量名、运算符、标点保持正文颜色，满屏都是颜色就等于没有颜色 */
export type CodeTone = 'keyword' | 'type' | 'string' | 'number' | 'atom' | 'property' | 'comment';

export interface CodeSegment {
  text: string;
  tone: CodeTone | null;
}

/**
 * 超过这么多字符就不上色，照原样给一段。
 * 实测 20 万字符的 JSON 解析 27ms、切出约 1.4 万个着色片段；ES 的 JSON 视图本来就截在这个长度
 */
export const MAX_HIGHLIGHTED_CHARS = 200_000;

const LANGUAGES: Record<CodeLanguage, Language> = {
  sql: StandardSQL.language,
  json: StreamLanguage.define(json),
  javascript: StreamLanguage.define(javascript),
  cypher: StreamLanguage.define(cypher)
};

// classHighlighter 给的是 `tok-string` 这样的类名，有时一个片段带好几个
const TONES: Array<[string, CodeTone]> = [
  ['tok-comment', 'comment'],
  ['tok-keyword', 'keyword'],
  ['tok-typeName', 'type'],
  ['tok-string', 'string'],
  ['tok-number', 'number'],
  ['tok-atom', 'atom'],
  ['tok-bool', 'atom'],
  ['tok-propertyName', 'property']
];

function toneOf(classes: string): CodeTone | null {
  const names = classes.split(' ');
  return TONES.find(([name]) => names.includes(name))?.[1] ?? null;
}

export function highlightSegments(code: string, language: CodeLanguage): CodeSegment[] {
  if (code === '') return [];
  if (code.length > MAX_HIGHLIGHTED_CHARS) return [{ text: code, tone: null }];

  const segments: CodeSegment[] = [];
  const push = (text: string, tone: CodeTone | null) => {
    const last = segments[segments.length - 1];
    if (last && last.tone === tone) last.text += text;
    else segments.push({ text, tone });
  };
  // MongoDB 的文档是 `{ _id: … }` 这样一个对象字面量，而 JavaScript 里开头的 `{` 是语句块，
  // 键名会被读成标签。套一层括号按表达式读，上色时只取原文那一段
  const wrapped = language === 'javascript' ? `(${code})` : code;
  const offset = wrapped === code ? 0 : 1;
  highlightCode(
    wrapped,
    LANGUAGES[language].parser.parse(wrapped),
    classHighlighter,
    (text, classes) => push(text, toneOf(classes)),
    () => push('\n', null),
    offset,
    offset + code.length
  );

  // JSON 的词法器把键和值都叫字符串；后面跟着冒号的是键，换个颜色才分得清哪边是名字
  if (language === 'json') {
    segments.forEach((segment, index) => {
      if (segment.tone === 'string' && segments[index + 1]?.text.trimStart().startsWith(':')) {
        segment.tone = 'property';
      }
    });
  }
  return segments;
}
