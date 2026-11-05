import { useMemo } from 'react';
import { highlightSegments, type CodeLanguage, type CodeSegment } from '../utils/codeHighlight';

/**
 * 上了色的一段代码，只换字不带外框：放进 `<pre>` 是代码块，放进 `<span>` 是折成一行的语句标题。
 * 外层的样式与截断都由调用方定
 */
export function HighlightedCode({ code, language }: { code: string; language: CodeLanguage }) {
  const segments = useMemo(() => highlightSegments(code, language), [code, language]);
  return <CodeSegments segments={segments} />;
}

/** 已经切好、标好色的片段（不经词法器，比如 pickle 的格式化器直接给出的） */
export function CodeSegments({ segments }: { segments: CodeSegment[] }) {
  return (
    <>
      {segments.map((segment, index) => (
        segment.tone === null ? segment.text : <span key={index} className={`code-${segment.tone}`}>{segment.text}</span>
      ))}
    </>
  );
}
