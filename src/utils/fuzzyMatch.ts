/**
 * 命令面板的模糊匹配。
 *
 * 规则是子序列匹配：查询里的字符按顺序出现在目标里即可，不要求连续。
 * 打分偏向「连续命中」和「命中词首」，因为输 `ordit` 想找的是
 * `order_items` 而不是某个碰巧含这几个字母的长串。
 */
export interface FuzzyMatch {
  score: number;
  /** 命中的字符下标，用于在界面上高亮 */
  indices: number[];
}

const CONSECUTIVE_BONUS = 8;
const WORD_START_BONUS = 10;
// 首字符奖励要明显小于「一段连续命中」的收益，否则从下标 0 起的匹配会压过
// 末尾那段完整连续的命中——查 ab 在 `a_xb ab` 里应当高亮末尾的 ab
const FIRST_CHAR_BONUS = 5;
const GAP_PENALTY = 2;

function isWordBoundary(text: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  const previous = text[index - 1];
  return previous === '_' || previous === '-' || previous === '.'
    || previous === ' ' || previous === '/' || previous === ':';
}

/**
 * 从 start 位置开始贪心匹配一次，返回得分和命中下标。
 * 匹配不完整时返回 null。
 */
function matchFrom(query: string, text: string, start: number): FuzzyMatch | null {
  const indices: number[] = [];
  let score = 0;
  let textIndex = start;
  let previousIndex = -2;

  for (const character of query) {
    let found = -1;
    for (let scan = textIndex; scan < text.length; scan += 1) {
      if (text[scan] === character) {
        found = scan;
        break;
      }
    }

    if (found < 0) {
      return null;
    }

    score += 1;
    if (found === previousIndex + 1) {
      score += CONSECUTIVE_BONUS;
    } else if (previousIndex >= 0) {
      // 跳过的字符越多越不像是想找的那个，但惩罚要小于词首奖励
      score -= Math.min(found - previousIndex - 1, 4) * GAP_PENALTY;
    }
    if (isWordBoundary(text, found)) {
      score += WORD_START_BONUS;
    }
    if (found === 0) {
      score += FIRST_CHAR_BONUS;
    }

    indices.push(found);
    previousIndex = found;
    textIndex = found + 1;
  }

  return { score, indices };
}

export function matchFuzzy(query: string, text: string): FuzzyMatch | null {
  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery.length === 0) {
    return { score: 0, indices: [] };
  }

  const normalizedText = text.toLowerCase();
  let best: FuzzyMatch | null = null;

  // 从每个能匹配首字符的位置各试一次，取最好的那次。
  // 只做一次贪心会漏掉更靠后的连续命中：查 `ab` 在 `a_xb ab` 里，
  // 贪心会停在 a(0)+b(3)，而真正想要的是末尾连续的 ab。
  for (let start = 0; start < normalizedText.length; start += 1) {
    if (normalizedText[start] !== normalizedQuery[0]) {
      continue;
    }

    const candidate = matchFrom(normalizedQuery, normalizedText, start);
    if (candidate && (!best || candidate.score > best.score)) {
      best = candidate;
    }
  }

  return best;
}

export interface FuzzyCandidate {
  /** 主文本，参与匹配并高亮 */
  title: string;
  /** 附加可搜索文本（比如所属 schema、连接名），参与匹配但不高亮 */
  keywords?: string;
}

export interface RankedResult<T> {
  item: T;
  score: number;
  indices: number[];
}

/**
 * 排序：分数降序，同分时短的在前（更可能是想找的那个），再同则保持原顺序。
 */
export function rankFuzzy<T extends FuzzyCandidate>(
  query: string,
  items: readonly T[]
): RankedResult<T>[] {
  const normalized = query.trim();

  if (normalized.length === 0) {
    return items.map((item, position) => ({ item, score: 0, indices: [], position }))
      .map(({ item, score, indices }) => ({ item, score, indices }));
  }

  const matched: (RankedResult<T> & { position: number })[] = [];

  items.forEach((item, position) => {
    const titleMatch = matchFuzzy(normalized, item.title);
    if (titleMatch) {
      matched.push({ item, score: titleMatch.score, indices: titleMatch.indices, position });
      return;
    }

    // 标题匹配不上再看附加文本；命中附加文本的排在命中标题的后面
    if (item.keywords) {
      const keywordMatch = matchFuzzy(normalized, item.keywords);
      if (keywordMatch) {
        matched.push({ item, score: keywordMatch.score - 1000, indices: [], position });
      }
    }
  });

  matched.sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    if (left.item.title.length !== right.item.title.length) {
      return left.item.title.length - right.item.title.length;
    }
    return left.position - right.position;
  });

  return matched.map(({ item, score, indices }) => ({ item, score, indices }));
}
