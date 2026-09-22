import type { ConnectionDiagnosis, ConnectionDiagnosisStep } from '../contracts/connectionDiagnosis';
import type { TranslationKey } from '../i18n/translate';

/**
 * 诊断结果怎么读：每一步一行标题，末尾一句结论。
 *
 * 结论只看**最后一步**，因为后端一失败就停——中间不会有「失败了又继续」的
 * 步骤。这让「成功到哪一步」和「下一步该查什么」变成同一个判断。
 */

/** 每一步显示成哪个标题。四种 sqlite 步骤问的是同一件事：那个文件 */
const STEP_TITLES: Readonly<Record<string, TranslationKey>> = {
  resolve: 'diagnosis.step.resolve',
  tcp: 'diagnosis.step.tcp',
  tcpDropped: 'diagnosis.step.tcp',
  sqliteFile: 'diagnosis.step.file',
  sqliteMemory: 'diagnosis.step.file',
  sqliteEmpty: 'diagnosis.step.file',
  sqliteMagic: 'diagnosis.step.file',
  // 后端把「要区分的情况」做成了新的步骤名而不是新写一句中文，所以这里跟着长
  sqliteMissingPath: 'diagnosis.step.file',
  sqliteDirectory: 'diagnosis.step.file',
  hostMissing: 'diagnosis.step.resolve',
  portMissing: 'diagnosis.step.tcp',
  resolveTimeout: 'diagnosis.step.resolve',
  resolveEmpty: 'diagnosis.step.resolve',
  tcpTimeout: 'diagnosis.step.tcp'
};

/**
 * 最后一步 → 结论。
 *
 * 键写成 `名字:成败` 而不是嵌套两层：这张表要能一眼看全，漏掉一格就是界面上
 * 少一句结论。成功与失败**分开列**，因为同一步成功和失败要说的话毫不相干：
 * 端口连上了说明「网络这段没问题」，连不上说明「服务或防火墙」。
 */
const CONCLUSIONS: Readonly<Record<string, TranslationKey>> = {
  'resolve:false': 'diagnosis.conclusion.resolveFailed',
  'tcp:true': 'diagnosis.conclusion.reachable',
  'tcp:false': 'diagnosis.conclusion.tcpFailed',
  'tcpDropped:false': 'diagnosis.conclusion.tcpDropped',
  'sqliteFile:true': 'diagnosis.conclusion.fileOk',
  'sqliteFile:false': 'diagnosis.conclusion.fileFailed',
  'sqliteMemory:true': 'diagnosis.conclusion.memory',
  'sqliteEmpty:true': 'diagnosis.conclusion.emptyFile',
  'sqliteMagic:false': 'diagnosis.conclusion.notSqlite',
  'sqliteMissingPath:false': 'diagnosis.conclusion.missingPath',
  'sqliteDirectory:false': 'diagnosis.conclusion.notAFile',
  'hostMissing:false': 'diagnosis.conclusion.hostMissing',
  'portMissing:false': 'diagnosis.conclusion.portMissing',
  'resolveTimeout:false': 'diagnosis.conclusion.resolveTimeout',
  'resolveEmpty:false': 'diagnosis.conclusion.resolveEmpty',
  'tcpTimeout:false': 'diagnosis.conclusion.tcpTimeout'
};

export interface DiagnosisLine {
  readonly titleKey: TranslationKey;
  readonly ok: boolean;
  readonly detail: string;
  readonly elapsedMs: number;
}

export function diagnosisLines(diagnosis: ConnectionDiagnosis): DiagnosisLine[] {
  return diagnosis.steps.map((step) => ({
    // 认不出的步骤名仍然要显示出来：后端加了一步而前端还没跟上时，
    // 少一行比多一行难发现得多
    titleKey: STEP_TITLES[step.name] ?? 'diagnosis.step.unknown',
    ok: step.ok,
    detail: step.detail,
    elapsedMs: step.elapsedMs
  }));
}

/**
 * 这次诊断说明什么。查不出结论时返回 null，由界面只列步骤不硬凑一句话——
 * 编一句「可能是网络问题」比不说更糟，它会把人引向一个没有根据的方向。
 */
export function diagnosisConclusionKey(diagnosis: ConnectionDiagnosis): TranslationKey | null {
  const last: ConnectionDiagnosisStep | undefined =
    diagnosis.steps[diagnosis.steps.length - 1];
  if (!last) {
    return null;
  }

  return CONCLUSIONS[`${last.name}:${last.ok}`] ?? null;
}

/** 整次诊断是不是全通。全通仍然可能连不上——那时问题在账号、TLS 或库名 */
export function diagnosisPassed(diagnosis: ConnectionDiagnosis): boolean {
  return diagnosis.steps.length > 0 && diagnosis.steps.every((step) => step.ok);
}
