import {
  cypherName,
  cypherString,
  type CypherNodeValue,
  type CypherRelationshipValue,
  type CypherValue
} from './cypherValue';

/**
 * 在界面上改节点与关系：改属性、加摘标签、删、建节点。这里只生成 Cypher，由查询标签去跑。
 *
 * 属性的值**按 Cypher 表达式写**：`'文字'`、`42`、`date('2024-01-01')`、`[1, 2]`。
 * Neo4j 的属性没有声明类型，类型只能从写法里来——输入框里放的就是当前值的字面量，
 * 原样不动就是不改，改成 `43` 就是整数、`'43'` 就是字符串。
 *
 * 用 `elementId` 定位，一条语句只动一个实体；语句以 `RETURN` 结尾，拿回改完的样子，
 * 结果里的旧值按它换掉。
 */

export type EditableEntity = CypherNodeValue | CypherRelationshipValue;

export interface PropertyDraft {
  /** 原来的键；新加的是 `null` */
  originalKey: string | null;
  key: string;
  /** Cypher 表达式。原值写不成字面量（字节串等）时是 `null`：只能留着或删掉，不能改 */
  value: string | null;
}

export interface EntityDraft {
  /** 关系没有标签（类型建了就不能改），这一项对关系不起作用 */
  labels: string[];
  properties: PropertyDraft[];
}

export type DraftProblem =
  | { kind: 'empty-key' }
  | { kind: 'duplicate-key'; key: string }
  | { kind: 'empty-value'; key: string };

export type EntityWrite =
  | { kind: 'unchanged' }
  | { kind: 'invalid'; problem: DraftProblem }
  | { kind: 'write'; statement: string; labelsChanged: boolean };

/**
 * 一个值的字面量写法，能原样写回去的那种；写不成的（字节串、节点、关系、路径）是 `null`。
 *
 * 与 `formatCypherValue` 的不同只在两处：顶层字符串也带引号，`NaN` 与无穷大没有字面量，
 * 写成 `toFloat('NaN')`（服务端上验过，读回来就是这三个值）
 */
export function cypherLiteral(value: CypherValue): string | null {
  switch (value.kind) {
    case 'null':
      return 'null';
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'float':
      return ['NaN', 'Infinity', '-Infinity'].includes(value.value) ? `toFloat('${value.value}')` : value.value;
    case 'integer':
    case 'point':
    case 'temporal':
      return value.value;
    case 'string':
      return cypherString(value.value);
    case 'list': {
      const items = value.items.map(cypherLiteral);
      return items.every((item) => item !== null) ? `[${items.join(', ')}]` : null;
    }
    case 'map': {
      const entries = value.entries.map(([key, item]) => [key, cypherLiteral(item)] as const);
      return entries.every(([, item]) => item !== null)
        ? `{${entries.map(([key, item]) => `${cypherName(key)}: ${item}`).join(', ')}}`
        : null;
    }
    case 'bytes':
    case 'node':
    case 'relationship':
    case 'path':
    case 'unsupported':
      return null;
  }
}

/** 编辑框的起点。`null` 是建一个新节点 */
export function draftOf(entity: EditableEntity | null): EntityDraft {
  return {
    labels: entity?.kind === 'node' ? [...entity.labels] : [],
    properties: (entity?.properties ?? []).map(([key, value]) => ({ originalKey: key, key, value: cypherLiteral(value) }))
  };
}

function effective(property: PropertyDraft): { key: string; value: string | null } {
  return { key: property.key.trim(), value: property.value?.trim() ?? null };
}

function problemOf(properties: PropertyDraft[]): DraftProblem | null {
  const seen = new Set<string>();
  for (const property of properties) {
    const { key, value } = effective(property);
    if (key === '') return { kind: 'empty-key' };
    if (seen.has(key)) return { kind: 'duplicate-key', key };
    seen.add(key);
    if (value === '') return { kind: 'empty-value', key };
  }
  return null;
}

function labelsText(labels: string[]): string {
  return labels.map((label) => `:${cypherName(label)}`).join('');
}

/** 按 `elementId` 定位一个实体的那一句 */
function matchClause(entity: EditableEntity): string {
  return entity.kind === 'node'
    ? `MATCH (n) WHERE elementId(n) = ${cypherString(entity.elementId)}`
    : `MATCH ()-[r]->() WHERE elementId(r) = ${cypherString(entity.elementId)}`;
}

function variableOf(entity: EditableEntity): 'n' | 'r' {
  return entity.kind === 'node' ? 'n' : 'r';
}

/**
 * 把编辑框里的样子写成一条语句。`entity` 为 `null` 时是建节点。
 *
 * 改键（`a` 改成 `b`）是摘掉 `a`、设上 `b`。`REMOVE` 写在 `SET` 前面：把 `a` 改名为 `b`、
 * 又新加一个 `a` 时，先设后摘会把新加的那个摘掉
 */
export function entityWrite(entity: EditableEntity | null, input: EntityDraft): EntityWrite {
  // 点了「加属性」还没填的那一行不算数：刚点出来就报「键空着」只是吵
  const draft = {
    ...input,
    properties: input.properties.filter((property) =>
      property.originalKey !== null || property.key.trim() !== '' || (property.value ?? '').trim() !== '')
  };
  const problem = problemOf(draft.properties);
  if (problem) return { kind: 'invalid', problem };
  const labels = [...new Set(draft.labels.map((label) => label.trim()).filter((label) => label !== ''))];

  if (!entity) {
    const properties = draft.properties.map(effective).filter((property) => property.value !== null);
    const map = properties.length === 0
      ? ''
      : ` {${properties.map(({ key, value }) => `${cypherName(key)}: ${value}`).join(', ')}}`;
    return { kind: 'write', statement: `CREATE (n${labelsText(labels)}${map})\nRETURN n`, labelsChanged: labels.length > 0 };
  }

  const variable = variableOf(entity);
  const originals = new Map(entity.properties.map(([key, value]) => [key, cypherLiteral(value)]));
  const kept = new Set(draft.properties.map((property) => property.originalKey));
  const removals: string[] = [];
  const assignments: string[] = [];
  for (const key of originals.keys()) {
    if (!kept.has(key)) removals.push(`${variable}.${cypherName(key)}`);
  }
  for (const property of draft.properties) {
    const { key, value } = effective(property);
    // 写不成字面量的原值不能改，改了键也不算（界面上那一格是只读的）
    if (value === null) continue;
    const renamedFrom = property.originalKey !== null && property.originalKey !== key ? property.originalKey : null;
    if (renamedFrom !== null) removals.push(`${variable}.${cypherName(renamedFrom)}`);
    if (renamedFrom !== null || property.originalKey === null || originals.get(key) !== value) {
      assignments.push(`${variable}.${cypherName(key)} = ${value}`);
    }
  }
  let labelsChanged = false;
  if (entity.kind === 'node') {
    const removedLabels = entity.labels.filter((label) => !labels.includes(label));
    const addedLabels = labels.filter((label) => !entity.labels.includes(label));
    if (removedLabels.length > 0) removals.push(`n${labelsText(removedLabels)}`);
    if (addedLabels.length > 0) assignments.push(`n${labelsText(addedLabels)}`);
    labelsChanged = removedLabels.length + addedLabels.length > 0;
  }
  if (removals.length === 0 && assignments.length === 0) return { kind: 'unchanged' };

  const lines = [matchClause(entity)];
  if (removals.length > 0) lines.push(`REMOVE ${removals.join(', ')}`);
  if (assignments.length > 0) lines.push(`SET ${assignments.join(', ')}`);
  lines.push(`RETURN ${variable}`);
  return { kind: 'write', statement: lines.join('\n'), labelsChanged };
}

/** 删之前先数一下连着几条关系：自环只算一条（服务端上验过） */
export function degreeStatement(node: CypherNodeValue): string {
  return `${matchClause(node)}\nRETURN COUNT { (n)--() } AS relationships`;
}

/**
 * 删一个实体。节点只在确认过「连着的关系一起删」之后才用 `DETACH`：数完到删之间有人
 * 连上了新关系的话，不带 `DETACH` 的删除会报错，而不是悄悄删掉一条没人告诉过你的关系
 */
export function deleteStatement(entity: EditableEntity, detach: boolean): string {
  const variable = variableOf(entity);
  return `${matchClause(entity)}\n${detach && entity.kind === 'node' ? 'DETACH ' : ''}DELETE ${variable}`;
}

/** 这个值里（钻进列表、映射、路径）有没有哪一处让 `test` 为真 */
function mentions(value: CypherValue, test: (entity: EditableEntity) => boolean): boolean {
  switch (value.kind) {
    case 'node':
    case 'relationship':
      return test(value);
    case 'list':
      return value.items.some((item) => mentions(item, test));
    case 'map':
      return value.entries.some(([, item]) => mentions(item, test));
    case 'path':
      return test(value.start) || value.segments.some((segment) => test(segment.relationship) || test(segment.node));
    default:
      return false;
  }
}

function replaced(value: CypherValue, updated: EditableEntity): CypherValue {
  switch (value.kind) {
    case 'node':
      return updated.kind === 'node' && value.elementId === updated.elementId ? updated : value;
    case 'relationship':
      return updated.kind === 'relationship' && value.elementId === updated.elementId ? updated : value;
    case 'list':
      return { kind: 'list', items: value.items.map((item) => replaced(item, updated)) };
    case 'map':
      return { kind: 'map', entries: value.entries.map(([key, item]) => [key, replaced(item, updated)]) };
    case 'path':
      return {
        kind: 'path',
        start: replaced(value.start, updated) as CypherNodeValue,
        segments: value.segments.map((segment) => ({
          ...segment,
          // 路径里关系的起止是按走向补的，与 `RETURN r` 拿回来的一致；属性换成新的就够了
          relationship: replaced(segment.relationship, updated) as CypherRelationshipValue,
          node: replaced(segment.node, updated) as CypherNodeValue
        }))
      };
    default:
      return value;
  }
}

/** 改完之后：结果里每一处这个实体都换成改完的样子，没提到它的行原样返回 */
export function replaceEntity(rows: CypherValue[][], updated: EditableEntity): CypherValue[][] {
  const test = (entity: EditableEntity) => entity.elementId === updated.elementId && entity.kind === updated.kind;
  return rows.map((row) => (row.some((value) => mentions(value, test)) ? row.map((value) => replaced(value, updated)) : row));
}

/**
 * 删完之后：提到它的行整行拿掉。删的是节点时，连着它的关系也跟着没了（`DETACH`），
 * 提到那些关系的行一并拿掉
 */
export function removeEntity(rows: CypherValue[][], deleted: EditableEntity): CypherValue[][] {
  const test = (entity: EditableEntity) =>
    (entity.kind === deleted.kind && entity.elementId === deleted.elementId)
    || (deleted.kind === 'node' && entity.kind === 'relationship'
      && (entity.startElementId === deleted.elementId || entity.endElementId === deleted.elementId));
  return rows.filter((row) => !row.some((value) => mentions(value, test)));
}
