import type { SqlDialect } from '../contracts/queryExecution';
import type { CodeLanguage } from './codeHighlight';
import { isCodegenDialect, type CodegenDialect, type CodegenSchema, type GeneratedCode } from './codegenModel';
import { generatePrisma, isPrismaDialect } from './codegenPrisma';
import { generateTypeorm } from './codegenTypeorm';
import { generateMikroorm, isMikroormDialect } from './codegenMikroorm';

/** 代码生成的目标：对话框里的选项、预览用的语言、各自支持的方言（rfcs/codegen.md §2） */
export interface CodegenTarget {
  id: 'prisma' | 'typeorm' | 'mikroorm';
  label: string;
  language: CodeLanguage;
  supports: (dialect: CodegenDialect) => boolean;
  generate: (schema: CodegenSchema, source: string) => GeneratedCode;
}

export const CODEGEN_TARGETS: CodegenTarget[] = [
  {
    id: 'prisma',
    label: 'Prisma',
    language: 'prisma',
    supports: isPrismaDialect,
    generate: (schema, source) => {
      const { dialect } = schema;
      if (!isPrismaDialect(dialect)) throw new Error(`Prisma does not support ${dialect}`);
      return generatePrisma({ ...schema, dialect }, source);
    }
  },
  {
    id: 'typeorm',
    label: 'TypeORM',
    language: 'typescript',
    supports: () => true,
    generate: generateTypeorm
  },
  {
    id: 'mikroorm',
    label: 'MikroORM',
    language: 'typescript',
    supports: isMikroormDialect,
    generate: (schema, source) => {
      const { dialect } = schema;
      if (!isMikroormDialect(dialect)) throw new Error(`MikroORM does not support ${dialect}`);
      return generateMikroorm({ ...schema, dialect }, source);
    }
  }
];

/** 这个方言能生成哪几种；DuckDB、ClickHouse 一种都没有，入口不出现 */
export function codegenTargetsFor(dialect: SqlDialect): CodegenTarget[] {
  return isCodegenDialect(dialect) ? CODEGEN_TARGETS.filter((target) => target.supports(dialect)) : [];
}
