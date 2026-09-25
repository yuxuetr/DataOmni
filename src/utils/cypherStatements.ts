/**
 * Cypher 的文字层面：按 `;` 拆语句、取出字符串与注释之外的关键字。
 *
 * 字符串是 `'…'` 或 `"…"`，里面用反斜杠转义（Cypher 不认 SQL 那种 `''`）；
 * 反引号括起来的是名字，`` `` `` 表示一个反引号；注释是 `//` 到行尾与 `/* … *\/`。
 * 这几种里的 `;` 与关键字都不算数。
 */

export interface CypherStatement {
  text: string;
  /** 在原文里的起止偏移，给「光标所在的那条」用 */
  from: number;
  to: number;
}

type Piece = { kind: 'code' | 'quoted' | 'comment'; text: string; from: number };

/** 把原文切成代码、引号里的内容、注释三种片段 */
function pieces(source: string): Piece[] {
  const result: Piece[] = [];
  let index = 0;
  let codeStart = 0;
  const flushCode = (end: number) => {
    if (end > codeStart) result.push({ kind: 'code', text: source.slice(codeStart, end), from: codeStart });
  };
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    let end = -1;
    let kind: Piece['kind'] = 'quoted';
    if (char === "'" || char === '"') {
      end = index + 1;
      while (end < source.length && source[end] !== char) end += source[end] === '\\' ? 2 : 1;
      end = Math.min(end + 1, source.length);
    } else if (char === '`') {
      end = index + 1;
      while (end < source.length) {
        if (source[end] === '`' && source[end + 1] === '`') end += 2;
        else if (source[end] === '`') break;
        else end += 1;
      }
      end = Math.min(end + 1, source.length);
    } else if (char === '/' && next === '/') {
      kind = 'comment';
      end = source.indexOf('\n', index);
      if (end === -1) end = source.length;
    } else if (char === '/' && next === '*') {
      kind = 'comment';
      end = source.indexOf('*/', index + 2);
      end = end === -1 ? source.length : end + 2;
    }
    if (end === -1) {
      index += 1;
      continue;
    }
    flushCode(index);
    result.push({ kind, text: source.slice(index, end), from: index });
    index = end;
    codeStart = end;
  }
  flushCode(source.length);
  return result;
}

/** 按顶层的 `;` 拆开。只剩空白与注释的段落不算一条 */
export function splitCypherStatements(source: string): CypherStatement[] {
  const statements: CypherStatement[] = [];
  let start = 0;
  let hasCode = false;
  const close = (end: number) => {
    if (hasCode) {
      const raw = source.slice(start, end);
      const leading = raw.length - raw.trimStart().length;
      const text = raw.trim();
      statements.push({ text, from: start + leading, to: start + leading + text.length });
    }
    hasCode = false;
  };
  for (const piece of pieces(source)) {
    if (piece.kind === 'comment') continue;
    if (piece.kind === 'quoted') {
      hasCode = true;
      continue;
    }
    let offset = 0;
    for (const part of piece.text.split(';')) {
      if (part.trim() !== '') hasCode = true;
      offset += part.length;
      const semicolon = piece.from + offset;
      if (semicolon < piece.from + piece.text.length) {
        close(semicolon);
        start = semicolon + 1;
        offset += 1;
      }
    }
  }
  close(source.length);
  return statements;
}

/** 字符串、名字与注释之外的词，大写 */
export function cypherKeywords(source: string): string[] {
  return pieces(source)
    .filter((piece) => piece.kind === 'code')
    .flatMap((piece) => piece.text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
    .map((word) => word.toUpperCase());
}

export interface CypherPreamble {
  /** 开头写了 `EXPLAIN`（只出计划、不执行）还是 `PROFILE`（执行并量每一步） */
  mode: 'explain' | 'profile' | null;
  /** 摘掉那个词之后的原文；没有时就是原文 */
  body: string;
}

/**
 * 查询前面的预解析部分：`CYPHER 25 runtime=slotted` 这类选项与 `EXPLAIN` / `PROFILE`，
 * 次序随意、可以有注释。碰到第一个别的词（查询本身）或字符串就停，查询里叫 `explain` 的变量不算。
 */
export function cypherPreamble(source: string): CypherPreamble {
  let found: { mode: 'explain' | 'profile'; from: number; length: number } | null = null;
  // `CYPHER` 之后是一个可选的版本号与若干 `键=值`
  let expecting: 'statement' | 'version-or-option' | 'equals' | 'value' = 'statement';
  scan: for (const piece of pieces(source)) {
    if (piece.kind === 'comment') continue;
    if (piece.kind === 'quoted') break;
    for (const token of piece.text.matchAll(/[A-Za-z_][A-Za-z0-9_.]*|\d+(?:\.\d+)?|\S/g)) {
      const word = token[0].toUpperCase();
      const isName = /^[A-Z_]/.test(word);
      if (expecting === 'equals') {
        if (word !== '=') break scan;
        expecting = 'value';
        continue;
      }
      if (expecting === 'value') {
        expecting = 'version-or-option';
        continue;
      }
      if (word === 'EXPLAIN' || word === 'PROFILE') {
        found ??= { mode: word === 'EXPLAIN' ? 'explain' : 'profile', from: piece.from + (token.index ?? 0), length: word.length };
        expecting = 'statement';
      } else if (word === 'CYPHER') {
        expecting = 'version-or-option';
      } else if (expecting === 'version-or-option' && !isName) {
        // 版本号只在选项前面出现一次，这里不较真
      } else if (expecting === 'version-or-option' && isName && /^\s*=/.test(piece.text.slice((token.index ?? 0) + word.length))) {
        expecting = 'equals';
      } else {
        break scan;
      }
    }
  }
  if (!found) return { mode: null, body: source };
  return { mode: found.mode, body: source.slice(0, found.from) + source.slice(found.from + found.length) };
}

/**
 * 光标所在的那条。落在两条之间（分号后的空白）时算前一条，与 SQL 编辑器一致
 */
export function cypherStatementAt(source: string, offset: number): CypherStatement | null {
  const statements = splitCypherStatements(source);
  let found: CypherStatement | null = null;
  for (const statement of statements) {
    if (statement.from <= offset) found = statement;
  }
  return found ?? statements[0] ?? null;
}
