/**
 * 连接诊断的结果形状，与 Rust 的 `services::connection_probe` 一一对应。
 *
 * 后端只给**事实**：哪一步、成没成、操作系统说了什么、花了多久。
 * 「这说明什么」由 `utils/connectionDiagnosis.ts` 算出来——那是一句要翻译的
 * 结论，而结论放在后端就没法跟界面语言走。
 */
export interface ConnectionDiagnosisStep {
  /** 稳定标识：`resolve` | `tcp` | `sqliteFile` | `sqliteMemory` | `sqliteEmpty` | `sqliteMagic` */
  readonly name: string;
  readonly ok: boolean;
  /** 解析到的地址、失败原因、文件路径——给人看的事实，不翻译 */
  readonly detail: string;
  readonly elapsedMs: number;
}

export interface ConnectionDiagnosis {
  /** 按执行顺序；一步失败就停，所以最后一条决定了结论 */
  readonly steps: readonly ConnectionDiagnosisStep[];
}
