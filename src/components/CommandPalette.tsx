import { useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Search } from 'lucide-react';
import { rankFuzzy } from '../utils/fuzzyMatch';
import { useLanguageStore } from '../stores/languageStore';

export interface PaletteCommand {
  id: string;
  title: string;
  /** 参与搜索但不高亮，比如所属 schema、连接名 */
  keywords?: string;
  /** 右侧的分类标签 */
  group: string;
  /** 右侧的补充说明，比如 host:port */
  detail?: string;
  run: () => void;
}

interface CommandPaletteProps {
  commands: PaletteCommand[];
  onDismiss: () => void;
}

/** 把命中的字符标出来，其余原样 */
function HighlightedTitle({ title, indices }: { title: string; indices: number[] }) {
  if (indices.length === 0) {
    return <>{title}</>;
  }

  const hit = new Set(indices);
  return (
    <>
      {[...title].map((character, index) => (
        <span key={index} className={hit.has(index) ? 'font-semibold text-accent' : undefined}>
          {character}
        </span>
      ))}
    </>
  );
}

const MAX_VISIBLE = 50;

export function CommandPalette({ commands, onDismiss }: CommandPaletteProps) {
  const t = useLanguageStore((state) => state.t);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const results = useMemo(
    () => rankFuzzy(query, commands).slice(0, MAX_VISIBLE),
    [query, commands]
  );

  // 结果变了就把高亮拉回第一条，否则会停在一个已经不存在的位置
  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  // 键盘移动后把当前项滚进可视区
  useEffect(() => {
    listRef.current?.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onDismiss();
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length === 0) {
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : -1;
      // 上下都回绕：列表短的时候回绕比撞墙好用
      setActiveIndex((current) => (current + step + results.length) % results.length);
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      const selected = results[activeIndex];
      if (selected) {
        onDismiss();
        selected.item.run();
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-scrim pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label={t('palette.label')}
      onClick={onDismiss}
    >
      <div
        className="flex max-h-[60vh] w-[560px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-panel bg-surface-raised shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Search size={15} className="shrink-0 text-fg-subtle" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('palette.search')}
            aria-label={t('palette.search')}
            className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-fg-subtle"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </div>

        {results.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-fg-subtle">{t('palette.noResults')}</p>
        ) : (
          <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1" role="listbox">
            {results.map((result, index) => (
              <li key={result.item.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => {
                    onDismiss();
                    result.item.run();
                  }}
                  className={clsx(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left',
                    index === activeIndex ? 'bg-accent-soft' : 'hover:bg-surface-hover'
                  )}
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-fg">
                    <HighlightedTitle title={result.item.title} indices={result.indices} />
                    {result.item.detail && (
                      <span className="ml-2 text-xs text-fg-subtle">{result.item.detail}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-[11px] text-fg-subtle">{result.item.group}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
