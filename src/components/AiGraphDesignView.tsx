import { useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, Loader2, Sparkles } from 'lucide-react';
import { clsx } from 'clsx';
import type { ConnectionProfile } from '../contracts';
import type { TranslationKey } from '../i18n/translate';
import { selectAiDesign, useAiDesignStore } from '../stores/aiDesignStore';
import { useAppStore } from '../stores/appStore';
import { useLanguageStore } from '../stores/languageStore';
import { useQueryStore } from '../stores/queryStore';
import { useSettingsStore } from '../stores/settingsStore';
import { aiConfigured, completeWithAi, isAiKeyMissing } from '../utils/aiSettings';
import { describeError } from '../utils/describeError';
import {
  buildGraphDesignMessages,
  layoutGraph,
  parseGraphDesign,
  planGraphDesign,
  validateGraphDesign,
  type GraphDesign,
  type GraphIssueCode
} from '../utils/graphDesign';
import { AiRequestPanel } from './AiRequestPanel';
import { HighlightedCode } from './HighlightedCode';

const ISSUE_KEYS: Record<GraphIssueCode, TranslationKey> = {
  'no-labels': 'aiDesign.graphIssue.no-labels',
  'empty-name': 'aiDesign.graphIssue.empty-name',
  'duplicate-label': 'aiDesign.graphIssue.duplicate-label',
  'duplicate-property': 'aiDesign.graphIssue.duplicate-property',
  'unknown-property': 'aiDesign.graphIssue.unknown-property',
  'unknown-label': 'aiDesign.graphIssue.unknown-label',
  'duplicate-relationship': 'aiDesign.graphIssue.duplicate-relationship',
  'redundant-index': 'aiDesign.graphIssue.redundant-index'
};

const NODE_WIDTH = 170;
const ROW = 15;
const MAX_ROWS = 6;

interface AiGraphDesignViewProps {
  tabId: string;
  connection: ConnectionProfile;
}

/**
 * Neo4j 的 AI 设计：标签、关系类型画成图；能落到库里的唯一约束与索引在左边预览、执行（TODOs A9b）
 */
export function AiGraphDesignView({ tabId, connection }: AiGraphDesignViewProps) {
  const t = useLanguageStore((state) => state.t);
  const settings = useSettingsStore((state) => state.ai);
  const design = useAiDesignStore(selectAiDesign(tabId));
  const update = useAiDesignStore((state) => state.update);
  const markSchemaChanged = useAppStore((state) => state.markSchemaChanged);
  const objects = useAppStore((state) => state.databaseMetadata[connection.id]?.objects);
  const connectionString = useQueryStore((state) => state.connectionString);
  const timeoutMs = useQueryStore((state) => state.queryTimeoutMs);
  // 对象树里 Neo4j 的标签是 kind 为 label 的那一类（`neo4j_list_objects` 的约定）
  const existingLabels = useMemo(
    () => [...new Set((objects ?? []).filter((object) => object.kind === 'label').map((object) => object.name))],
    [objects]
  );

  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [created, setCreated] = useState<number | null>(null);

  const draft = design.graphDraft;
  const issues = useMemo(() => (draft ? validateGraphDesign(draft, existingLabels) : []), [draft, existingLabels]);
  const errors = issues.filter((issue) => issue.severity === 'error');
  const statements = useMemo(() => (draft && errors.length === 0 ? planGraphDesign(draft) : []), [draft, errors.length]);
  const configured = aiConfigured(settings);

  const generate = async () => {
    const messages = buildGraphDesignMessages(design.requirement, existingLabels, draft);
    update(tabId, { sent: messages, error: null, rawReply: null });
    setCreated(null);
    setRunning(true);
    try {
      const reply = await completeWithAi(settings, messages);
      const parsed = parseGraphDesign(reply);
      if (parsed.ok) {
        update(tabId, { graphDraft: parsed.design });
      } else {
        update(tabId, {
          rawReply: reply,
          error: t(parsed.reason === 'not-json' ? 'aiDesign.replyNotJson' : 'aiDesign.replyBadShape', { detail: parsed.detail })
        });
      }
    } catch (caught) {
      update(tabId, { error: isAiKeyMissing(caught) ? t('aiDesign.keyMissing') : describeError(caught) });
    } finally {
      setRunning(false);
    }
  };

  // 约束与索引是 schema 命令，每条自成一个事务；逐条发，失败时说停在哪
  const apply = async () => {
    if (!connectionString) {
      return;
    }
    setApplying(true);
    setApplyError(null);
    let done = 0;
    try {
      for (const query of statements) {
        await invoke('neo4j_run', {
          connectionString,
          database: connection.database || null,
          query,
          limit: 1,
          timeoutMs
        });
        done += 1;
      }
      markSchemaChanged();
      setCreated(statements.length);
    } catch (caught) {
      setApplyError(t('aiDesign.mongoFailedAt', { index: done + 1, done, detail: describeError(caught) }));
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="w-[420px] shrink-0 space-y-3 overflow-y-auto border-r border-line p-4">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-accent" />
          <h2 className="text-sm font-medium text-fg">{t('aiDesign.title')}</h2>
          <span className="ml-auto text-xs text-fg-subtle">{connection.name} · Neo4j</span>
        </div>

        <AiRequestPanel
          requirement={design.requirement}
          onRequirementChange={(requirement) => update(tabId, { requirement })}
          hasDraft={draft !== null}
          configured={configured}
          running={running}
          onGenerate={() => void generate()}
          onDiscard={() => update(tabId, { graphDraft: null, sent: null, rawReply: null, error: null })}
          sent={design.sent}
          error={design.error}
          rawReply={design.rawReply}
        />

        {created !== null && (
          <p className="rounded-control border border-line bg-surface-sunken px-3 py-2 text-xs text-success">
            {t('aiDesign.graphCreated', { count: created })}
          </p>
        )}

        {draft && (
          <>
            {issues.length === 0 ? (
              <p className="text-xs text-success">{t('aiDesign.noIssues')}</p>
            ) : (
              <ul className="space-y-1">
                {issues.map((issue, index) => (
                  <li key={index} className={clsx('flex gap-1.5 text-xs', issue.severity === 'error' ? 'text-danger' : 'text-warning')}>
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span className="break-words">
                      <span className="font-mono">{issue.subject}</span>
                      {issue.subject && ' · '}
                      {t(ISSUE_KEYS[issue.code], { detail: issue.detail })}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <p className="text-xs text-fg-subtle">{t('aiDesign.graphNote')}</p>
            {statements.length > 0 && (
              <details className="text-xs text-fg-muted" open>
                <summary className="cursor-pointer select-none">{t('aiDesign.mongoSteps', { count: statements.length })}</summary>
                <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-control border border-line bg-surface-sunken p-2 font-mono text-fg select-text">
                  <HighlightedCode code={statements.join(';\n') + ';'} language="cypher" />
                </pre>
              </details>
            )}
            <button
              type="button"
              onClick={() => void apply()}
              disabled={applying || statements.length === 0 || !connectionString}
              className="flex items-center gap-1.5 rounded-control bg-accent px-3 py-1.5 text-sm text-fg-on-accent hover:opacity-90 disabled:opacity-50"
            >
              {applying && <Loader2 size={14} className="animate-spin" />}
              {t('aiDesign.graphApply', { count: statements.length })}
            </button>
            {applyError && <p className="break-words text-xs text-danger">{applyError}</p>}
          </>
        )}
      </div>

      <div className="min-w-0 flex-1 overflow-auto">
        {draft ? (
          <GraphModelDiagram design={draft} />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-center text-sm text-fg-muted">
            {t('aiDesign.empty')}
          </div>
        )}
      </div>
    </div>
  );
}

/** 节点框的高度：标题一行，加最多 MAX_ROWS 行属性 */
const nodeHeight = (rows: number) => 26 + Math.min(rows, MAX_ROWS) * ROW + 6;

/** 从框中心出发的线在框边上的交点：箭头要停在框边，不能钻进框里 */
function edgePoint(cx: number, cy: number, halfWidth: number, halfHeight: number, towardX: number, towardY: number) {
  const dx = towardX - cx;
  const dy = towardY - cy;
  if (dx === 0 && dy === 0) {
    return { x: cx, y: cy };
  }
  const scale = Math.min(halfWidth / Math.abs(dx || 1e-9), halfHeight / Math.abs(dy || 1e-9));
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function GraphModelDiagram({ design }: { design: GraphDesign }) {
  const { nodes, size } = useMemo(() => layoutGraph(design, NODE_WIDTH), [design]);
  const position = new Map(nodes.map((node) => [node.name, node]));
  const labels = new Map(design.labels.map((label) => [label.name, label]));

  // 同一对标签之间的几条关系错开画，否则叠成一条线
  const pairCount = new Map<string, number>();
  const pairIndex: number[] = design.relationships.map((relationship) => {
    const pair = [relationship.from, relationship.to].sort().join('\0');
    const index = pairCount.get(pair) ?? 0;
    pairCount.set(pair, index + 1);
    return index;
  });

  return (
    <svg width={size} height={size} className="block text-fg-muted" role="img">
      <defs>
        <marker id="graph-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
        </marker>
      </defs>

      {design.relationships.map((relationship, index) => {
        const from = position.get(relationship.from);
        const to = position.get(relationship.to);
        if (!from || !to) {
          return null;
        }
        const fromHeight = nodeHeight(labels.get(relationship.from)?.properties.length ?? 0);
        if (relationship.from === relationship.to) {
          // 自环：从框顶右侧绕一圈回到框顶左侧
          const top = from.y - fromHeight / 2;
          const loop = 36 + pairIndex[index]! * 18;
          return (
            <g key={index}>
              <path
                d={`M ${from.x + 30} ${top} C ${from.x + 60} ${top - loop}, ${from.x - 60} ${top - loop}, ${from.x - 30} ${top}`}
                fill="none"
                stroke="currentColor"
                markerEnd="url(#graph-arrow)"
              />
              <text x={from.x} y={top - loop * 0.75 - 4} textAnchor="middle" className="fill-accent text-[10px] font-medium">
                {relationship.type}
              </text>
            </g>
          );
        }
        const toHeight = nodeHeight(labels.get(relationship.to)?.properties.length ?? 0);
        const start = edgePoint(from.x, from.y, NODE_WIDTH / 2, fromHeight / 2, to.x, to.y);
        const end = edgePoint(to.x, to.y, NODE_WIDTH / 2, toHeight / 2, from.x, from.y);
        // 平行的几条按序号往两侧弯
        const bend = (pairIndex[index]! - ((pairCount.get([relationship.from, relationship.to].sort().join('\0')) ?? 1) - 1) / 2) * 40;
        const mx = (start.x + end.x) / 2;
        const my = (start.y + end.y) / 2;
        const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
        const cx = mx - ((end.y - start.y) / length) * bend;
        const cy = my + ((end.x - start.x) / length) * bend;
        return (
          <g key={index}>
            <path d={`M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`} fill="none" stroke="currentColor" markerEnd="url(#graph-arrow)" />
            <text x={(start.x + 2 * cx + end.x) / 4} y={(start.y + 2 * cy + end.y) / 4 - 4} textAnchor="middle" className="fill-accent text-[10px] font-medium">
              {relationship.type}
            </text>
          </g>
        );
      })}

      {nodes.map((node) => {
        const label = labels.get(node.name);
        if (!label) {
          return null;
        }
        const key = new Set(label.key);
        // 键排在前面：看一眼就知道这个节点靠什么认
        const rows = [...label.properties].sort((a, b) => Number(key.has(b.name)) - Number(key.has(a.name)));
        const height = nodeHeight(rows.length);
        const x = node.x - NODE_WIDTH / 2;
        const y = node.y - height / 2;
        return (
          <g key={node.name}>
            <rect x={x} y={y} width={NODE_WIDTH} height={height} rx={10} className="fill-surface stroke-line-strong" />
            <text x={node.x} y={y + 17} textAnchor="middle" className="fill-fg text-[12px] font-medium">
              :{label.name}
            </text>
            {rows.slice(0, MAX_ROWS).map((property, index) => (
              <text key={property.name} x={x + 10} y={y + 26 + (index + 1) * ROW - 3} className={clsx('text-[10px]', key.has(property.name) ? 'fill-accent font-medium' : 'fill-fg-subtle')}>
                {property.name}: {property.type}
              </text>
            ))}
            {rows.length > MAX_ROWS && (
              <text x={x + NODE_WIDTH - 10} y={y + height - 4} textAnchor="end" className="fill-fg-subtle text-[10px]">
                +{rows.length - MAX_ROWS}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
