// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CypilotBusEngine, LogRecord, SEVERITY_NAMES } from '../core/busEngine';

interface LogPanelProps {
  bus: CypilotBusEngine;
  logs: LogRecord[];
  compactDock?: boolean;
  onCloseDock?: () => void;
}

const NODE_BADGE_STYLES: Record<number, string> = {
  10: 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-700/70 dark:bg-sky-950/60 dark:text-sky-200',
  11: 'border-indigo-300 bg-indigo-50 text-indigo-900 dark:border-indigo-700/70 dark:bg-indigo-950/60 dark:text-indigo-200',
  12: 'border-teal-300 bg-teal-50 text-teal-900 dark:border-teal-700/70 dark:bg-teal-950/60 dark:text-teal-200',
  13: 'border-purple-300 bg-purple-50 text-purple-900 dark:border-purple-700/70 dark:bg-purple-950/60 dark:text-purple-200',
  20: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700/70 dark:bg-amber-950/60 dark:text-amber-200',
  30: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-700/70 dark:bg-emerald-950/60 dark:text-emerald-200',
};

const SEVERITY_BADGE_STYLES: Record<number, string> = {
  0: 'text-slate-400', // trace
  1: 'text-slate-500', // debug
  2: 'text-slate-700', // info
  3: 'text-blue-700 font-semibold', // notice
  4: 'text-[#ef6c00] font-semibold bg-amber-50/80', // warning
  5: 'text-[#c62828] font-bold bg-red-50/80', // error
  6: 'text-[#b71c1c] font-bold bg-red-100/80', // critical
  7: 'text-white font-bold bg-[#b71c1c]', // alert
};

function formatTimestamp(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatDeltaMs(prevSec: number | null, currSec: number): string {
  if (prevSec === null) return '+0ms';
  const diffMs = Math.max(0, Math.round((currSec - prevSec) * 1000));
  if (diffMs < 1000) return `+${diffMs}ms`;
  if (diffMs < 60000) return `+${(diffMs / 1000).toFixed(2)}s`;
  return `+${(diffMs / 60000).toFixed(1)}m`;
}

export const LogPanel: React.FC<LogPanelProps> = ({
  bus,
  logs,
  compactDock = false,
  onCloseDock,
}) => {
  // Empty set = all nodes enabled in the unified stream
  const [selectedNodes, setSelectedNodes] = useState<Set<string>>(new Set());
  const [minSeverity, setMinSeverity] = useState<number>(0);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [followTail, setFollowTail] = useState<boolean>(true);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);

  const onlineNodes = bus.nodes();
  const nodeNameMap = useMemo(() => {
    const map = new Map<number, string>();
    for (const n of onlineNodes) {
      map.set(n.nodeId, n.name ?? `node_${n.nodeId}`);
    }
    return map;
  }, [onlineNodes]);

  // Strictly chronological single stream across all nodes
  const chronologicalLogs = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return [...logs]
      .sort((a, b) => a.received - b.received || a.id - b.id)
      .filter((rec) => {
        if (rec.severity < minSeverity) return false;
        const nodeKey = rec.nodeId === null ? 'bus' : String(rec.nodeId);
        if (selectedNodes.size > 0 && !selectedNodes.has(nodeKey)) return false;
        if (q) {
          const role = rec.nodeId !== null ? (nodeNameMap.get(rec.nodeId) ?? '') : 'bus';
          const sev = SEVERITY_NAMES[rec.severity] ?? '';
          const haystack = `${rec.nodeId ?? 'bus'} ${role} ${sev} ${rec.text}`.toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        return true;
      });
  }, [logs, minSeverity, selectedNodes, searchQuery, nodeNameMap]);

  useEffect(() => {
    if (followTail && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [chronologicalLogs.length, followTail]);

  const toggleNodeKey = (key: string) => {
    setSelectedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Compact Multi-Node Stream Control Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-[11px] font-semibold text-slate-800 whitespace-nowrap">
            uavcan.diagnostic.Record ({chronologicalLogs.length}/{logs.length})
          </span>

          <div className="mx-0.5 h-3.5 w-px bg-slate-300" />

          {/* All Nodes Reset Button */}
          <button
            type="button"
            onClick={() => setSelectedNodes(new Set())}
            className={`rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors whitespace-nowrap ${
              selectedNodes.size === 0
                ? 'border-slate-800 bg-slate-800 font-semibold text-white'
                : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-100'
            }`}
            title="Show unified chronological log stream from all nodes"
          >
            ALL NODES
          </button>

          {/* Per-node quick toggle buttons */}
          {onlineNodes.map((n) => {
            const key = String(n.nodeId);
            const active = selectedNodes.has(key);
            const badgeStyle =
              NODE_BADGE_STYLES[n.nodeId] ?? 'border-slate-300 bg-slate-100 text-slate-800';
            return (
              <button
                key={n.nodeId}
                type="button"
                onClick={() => toggleNodeKey(key)}
                title={`Toggle node ${n.nodeId} (${n.name ?? 'unnamed'}) in unified stream`}
                className={`rounded border px-1.5 py-0.5 font-mono text-[10px] transition-all whitespace-nowrap ${
                  active
                    ? 'ring-1 ring-slate-900 font-semibold ' + badgeStyle
                    : selectedNodes.size === 0
                      ? badgeStyle + ' opacity-90 hover:opacity-100'
                      : 'border-slate-200 bg-white text-slate-400 hover:text-slate-700'
                }`}
              >
                {n.nodeId}:{n.name ?? '?'}
              </button>
            );
          })}

          <button
            type="button"
            onClick={() => toggleNodeKey('bus')}
            title="Toggle local session / bus events"
            className={`rounded border px-1.5 py-0.5 font-mono text-[10px] transition-all whitespace-nowrap ${
              selectedNodes.has('bus')
                ? 'border-slate-700 bg-slate-200 font-semibold text-slate-900 ring-1 ring-slate-900'
                : selectedNodes.size === 0
                  ? 'border-slate-300 bg-slate-100 text-slate-700'
                  : 'border-slate-200 bg-white text-slate-400 hover:text-slate-700'
            }`}
          >
            bus
          </button>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {/* Search input */}
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter stream..."
            className="w-32 rounded border border-slate-300 bg-white px-2 py-0.5 font-mono text-[11px] text-slate-800 placeholder:text-slate-400"
          />

          {/* Minimum severity selector */}
          <select
            value={minSeverity}
            onChange={(e) => setMinSeverity(Number(e.target.value))}
            title="Minimum diagnostic severity level"
            className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-[11px] text-slate-700"
          >
            <option value={0}>trace+ (all)</option>
            <option value={1}>debug+</option>
            <option value={2}>info+</option>
            <option value={3}>notice+</option>
            <option value={4}>warning+</option>
            <option value={5}>error+</option>
          </select>

          {/* Poll all nodes snapshot */}
          <button
            type="button"
            disabled={!bus.isConnected}
            onClick={() => bus.emitMultiNodeStatusRecords()}
            title="Emit synchronized diagnostic snapshot across all online nodes"
            className="rounded border border-slate-300 bg-white px-2 py-0.5 font-mono text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40 whitespace-nowrap"
          >
            Poll All Nodes
          </button>

          {/* Auto-scroll follow toggle */}
          <label
            className="flex cursor-pointer items-center gap-1 rounded border border-slate-300 bg-white px-2 py-0.5 font-mono text-[11px] text-slate-700 hover:bg-slate-100 whitespace-nowrap"
            title="Auto-scroll to newest record in chronological stream"
          >
            <input
              type="checkbox"
              checked={followTail}
              onChange={(e) => setFollowTail(e.target.checked)}
              className="rounded border-slate-300"
            />
            <span>Follow</span>
          </label>

          <button
            type="button"
            onClick={() => {
              bus.logs = [];
              bus.emitStatus('log cleared', false);
            }}
            className="rounded border border-slate-300 bg-white px-2 py-0.5 font-mono text-[11px] font-medium text-slate-700 hover:bg-slate-100"
          >
            Clear
          </button>

          {compactDock && onCloseDock && (
            <button
              type="button"
              onClick={onCloseDock}
              title="Collapse bottom multi-node log dock"
              className="rounded border border-slate-300 bg-white px-2 py-0.5 font-mono text-[11px] font-semibold text-slate-600 hover:bg-slate-100"
            >
              Hide
            </button>
          )}
        </div>
      </div>

      {/* Unified Chronological Single-Stream Log View */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto bg-[#FAFCFF] font-mono text-[11px] leading-5 select-text"
      >
        {chronologicalLogs.length === 0 ? (
          <div className="px-4 py-6 text-center font-sans text-xs text-slate-400">
            No diagnostic records match the current filter.
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {chronologicalLogs.map((rec, idx) => {
              const prevRec = idx > 0 ? chronologicalLogs[idx - 1] : null;
              const deltaText = formatDeltaMs(prevRec ? prevRec.received : null, rec.received);
              const sevName = (
                rec.severity >= 0 && rec.severity < SEVERITY_NAMES.length
                  ? SEVERITY_NAMES[rec.severity]
                  : '?'
              ).toUpperCase();
              const sevStyle = SEVERITY_BADGE_STYLES[rec.severity] ?? 'text-slate-700';

              const nodeRole =
                rec.nodeId !== null
                  ? (nodeNameMap.get(rec.nodeId) ?? `node_${rec.nodeId}`)
                  : 'bus';
              const nodeStyle =
                rec.nodeId !== null
                  ? (NODE_BADGE_STYLES[rec.nodeId] ??
                    'border-slate-300 bg-slate-100 text-slate-800')
                  : 'border-slate-300 bg-slate-200/70 text-slate-700';

              const isWarnOrErr = rec.severity >= 4;

              return (
                <div
                  key={rec.id}
                  className={`flex items-baseline gap-2 px-2.5 py-0.5 hover:bg-slate-100/80 ${
                    rec.severity >= 5
                      ? 'bg-red-50/40'
                      : rec.severity === 4
                        ? 'bg-amber-50/40'
                        : ''
                  }`}
                >
                  {/* Timestamp HH:MM:SS.mmm */}
                  <span className="w-[82px] shrink-0 tabular-nums text-slate-500">
                    {formatTimestamp(rec.received)}
                  </span>

                  {/* Chronological Δt from previous record */}
                  <span className="w-[54px] shrink-0 text-right tabular-nums text-[10px] text-slate-400">
                    {deltaText}
                  </span>

                  {/* Node ID + Role compact badge */}
                  <span
                    className={`inline-flex w-[124px] shrink-0 items-center justify-between truncate rounded border px-1.5 py-0 text-[10px] leading-4 ${nodeStyle}`}
                    title={
                      rec.nodeId !== null ? `Node ${rec.nodeId} (${nodeRole})` : 'Local bus session'
                    }
                  >
                    <span className="font-bold">
                      {rec.nodeId !== null ? `#${rec.nodeId}` : 'SYS'}
                    </span>
                    <span className="truncate pl-1 opacity-90">{nodeRole}</span>
                  </span>

                  {/* Severity tag */}
                  <span
                    className={`w-[56px] shrink-0 rounded px-1 text-center text-[10px] leading-4 ${sevStyle}`}
                  >
                    {sevName}
                  </span>

                  {/* Single-stream chronological log payload */}
                  <span
                    className={`min-w-0 flex-1 break-words ${
                      isWarnOrErr
                        ? rec.severity >= 5
                          ? 'font-semibold text-[#c62828]'
                          : 'font-medium text-[#ef6c00]'
                        : 'text-slate-800'
                    }`}
                  >
                    {rec.text}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
