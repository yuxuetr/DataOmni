import { useMemo } from 'react';
import { highlightSegments, type CodeLanguage } from '../utils/codeHighlight';

/**
 * 上了色的一段代码，只换字不带外框：放进 `<pre>` 是代码块，放进 `<span>` 是折成一行的语句标题。
 * 外层的样式与截断都由调用方定
 */
export function HighlightedCode({ code, language }: { code: string; language: CodeLanguage }) {
  const segments = useMemo(() => highlightSegments(code, language), [code, language]);
  return (
    <>
      {segments.map((segment, index) => (
        segment.tone === null ? segment.text : <span key={index} className={`code-${segment.tone}`}>{segment.text}</span>
      ))}
    </>
  );
}
