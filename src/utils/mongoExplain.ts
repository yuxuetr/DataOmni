/** 与后端 `MongoExplain` 一致 */
export interface MongoPlanStage {
  depth: number;
  stage: string;
  index: string | null;
}

export interface MongoExplain {
  stages: MongoPlanStage[];
  returned: number | null;
  docsExamined: number | null;
  keysExamined: number | null;
  millis: number | null;
  text: string;
}

/**
 * 执行计划的结论，只分三种：用上了索引、扫了整个集合、两者都不是（比如 `$group`
 * 整条下推后只剩 `EOF`，或者视图）。摘要只替人回答「要不要建索引」，别的看全文
 */
export type ExplainVerdict = 'index' | 'collection-scan' | 'other';

export function explainVerdict(explain: Pick<MongoExplain, 'stages'>): ExplainVerdict {
  // 两者都有时（`$or` 的一支走了索引、另一支没有）按扫全集合算：慢的是那一支
  if (explain.stages.some((stage) => stage.stage === 'COLLSCAN')) {
    return 'collection-scan';
  }
  if (explain.stages.some((stage) => stage.stage === 'IXSCAN' || stage.stage === 'EXPRESS_IXSCAN' || stage.stage === 'IDHACK' || stage.stage === 'EXPRESS_IDHACK')) {
    return 'index';
  }
  return 'other';
}

/** 计划的一行：缩进表示层级，索引扫描带上索引名 */
export function planLine(stage: MongoPlanStage): string {
  return `${'  '.repeat(stage.depth)}${stage.stage}${stage.index ? ` (${stage.index})` : ''}`;
}
