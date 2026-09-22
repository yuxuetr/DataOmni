import { Copy, FileText, Table2, Code2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useLanguageStore } from '../stores/languageStore';
import { useContextMenu } from '../hooks/useContextMenu';
import { OBJECT_MENU_ACTIONS, type ObjectMenuAction } from '../utils/objectMenu';
import type { DatabaseObject } from '../utils/databaseObjects';
import type { TranslationKey } from '../i18n/translate';

const ACTION_LABEL_KEYS: Record<ObjectMenuAction, TranslationKey> = {
  'open-data': 'explorer.menu.openData',
  'open-structure': 'explorer.menu.openStructure',
  'view-definition': 'explorer.menu.viewDefinition',
  'copy-name': 'explorer.menu.copyName'
};

const ACTION_ICONS: Record<ObjectMenuAction, LucideIcon> = {
  'open-data': Table2,
  'open-structure': FileText,
  'view-definition': Code2,
  'copy-name': Copy
};

interface ObjectContextMenuProps {
  object: DatabaseObject;
  position: { x: number; y: number };
  onRun: (action: ObjectMenuAction) => void;
  onDismiss: () => void;
}

/**
 * 对象树的右键菜单。
 *
 * 左键此前是唯一的入口，而它只能做一件事（有行的打开数据，没行的看定义）。
 * 「打开结构」的标签类型 `table-structure` 早就实现完整了，只是没有任何地方
 * 造得出这种标签——这个菜单把那条已经能跑的路接上。
 */
export function ObjectContextMenu({
  object,
  position,
  onRun,
  onDismiss
}: ObjectContextMenuProps) {
  const t = useLanguageStore((state) => state.t);
  const { ref, style } = useContextMenu<HTMLDivElement>(position, onDismiss);

  return (
    <div
      ref={ref}
      role="menu"
      style={style}
      className="fixed z-50 min-w-44 rounded-control border border-line-strong bg-surface py-1 shadow-lg"
    >
      {/* 名字放在最上面：右击的那一行会被菜单盖住，不写出来就不确定点中了谁 */}
      <div className="truncate px-3 py-1 text-xs text-fg-subtle" title={object.name}>
        {object.schema ? `${object.schema}.${object.name}` : object.name}
      </div>
      <div className="my-1 border-t border-line" />

      {OBJECT_MENU_ACTIONS[object.kind].map((action) => {
        const Icon = ACTION_ICONS[action];
        return (
          <button
            key={action}
            type="button"
            role="menuitem"
            onClick={() => {
              onRun(action);
              onDismiss();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-fg hover:bg-surface-hover"
          >
            <Icon size={14} className="shrink-0 text-fg-muted" />
            <span>{t(ACTION_LABEL_KEYS[action])}</span>
          </button>
        );
      })}
    </div>
  );
}
