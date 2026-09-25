/**
 * 「开出来就跑一次」的查询标签：从对象树点一个 Neo4j 标签时，新标签里的那条 `MATCH` 要自己跑，
 * 不然点一下只看到一段查询文字。
 *
 * 只是一个标签 id 的集合、取一次就删，不进 zustand：没有谁需要为它重渲染，
 * 也不该持久化——重启后恢复出来的标签不该再自己跑一遍。
 */
const pending = new Set<string>();

export function requestCypherAutorun(tabId: string): void {
  pending.add(tabId);
}

/** 这个标签要不要自己跑；问过一次就不再算数 */
export function takeCypherAutorun(tabId: string): boolean {
  return pending.delete(tabId);
}
