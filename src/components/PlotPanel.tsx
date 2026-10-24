// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useMemo, useState } from 'react';
import { CypilotBusEngine } from '../core/busEngine';
import { Recorder, RecordingSnapshot } from '../core/signals';

interface PlotPanelProps {
  bus: CypilotBusEngine;
}

const CURVE_COLORS = [
  '#3b82f6', // blue
  '#ef4444', // red
  '#10b981', // emerald
  '#f59e0b', // amber
  '#a855f7', // purple
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#84cc16', // lime
];

type MultiPlotLayout = 1 | 2 | 4;

function defaultPaneForField(field: string): number {
  if (field.includes('i_q') || field.includes('i_d') || field.includes('current')) return 1;
  if (field.includes('speed') || field.includes('position')) return 2;
  if (field.includes('v_dc') || field.includes('voltage')) return 3;
  return 4;
}

export const PlotPanel: React.FC<PlotPanelProps> = ({ bus }) => {
  const [spanSec, setSpanSec] = useState<number>(30.0);
  const [paused, setPaused] = useState<boolean>(false);
  const [replayRecorder, setReplayRecorder] = useState<Recorder | null>(null);
  const [selectedCurves, setSelectedCurves] = useState<Set<string>>(
    new Set(['10/telemetry:i_q', '10/telemetry:speed', '10/telemetry:v_dc'])
  );
  // Per-curve subplot pane assignment (1..4)
  const [curvePaneMap, setCurvePaneMap] = useState<Record<string, number>>({
    '10/telemetry:i_q': 1,
    '10/telemetry:speed': 2,
    '10/telemetry:v_dc': 3,
  });
  const [plotLayout, setPlotLayout] = useState<MultiPlotLayout>(2);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(false);
  const [exportModalOpen, setExportModalOpen] = useState<boolean>(false);
  const [loadModalOpen, setLoadModalOpen] = useState<boolean>(false);
  const [activeExport, setActiveExport] = useState<RecordingSnapshot | null>(null);
  const [hoverXRatio, setHoverXRatio] = useState<number | null>(null);
  const [, setRefreshTick] = useState(0);

  const isReplay = replayRecorder !== null;
  const activeRecorder = replayRecorder ?? bus.liveRecorder;

  useEffect(() => {
    if (paused || isReplay) return;
    const timer = window.setInterval(() => {
      setRefreshTick((t) => t + 1);
    }, 100);
    return () => window.clearInterval(timer);
  }, [paused, isReplay]);

  const availableSources = useMemo(() => {
    if (isReplay && replayRecorder) {
      return replayRecorder.sourceKeys().map((k) => replayRecorder.source(k)!);
    }
    return bus.allSources();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus, isReplay, replayRecorder, bus.nodes().length]);

  const toggleSource = (key: string, checked: boolean) => {
    if (isReplay) return;
    bus.setSourceSubscribed(key, checked);
    setRefreshTick((t) => t + 1);
  };

  const toggleCurve = (sourceKey: string, fieldName: string, checked: boolean) => {
    const curveKey = `${sourceKey}:${fieldName}`;
    setSelectedCurves((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(curveKey);
        if (!isReplay && !bus.isSourceSubscribed(sourceKey)) {
          bus.setSourceSubscribed(sourceKey, true);
        }
      } else {
        next.delete(curveKey);
      }
      return next;
    });
    if (checked && !curvePaneMap[curveKey]) {
      setCurvePaneMap((prev) => ({
        ...prev,
        [curveKey]: defaultPaneForField(fieldName),
      }));
    }
  };

  const setCurvePane = (curveKey: string, paneIndex: number) => {
    setCurvePaneMap((prev) => ({
      ...prev,
      [curveKey]: paneIndex,
    }));
  };

  const handleClear = () => {
    if (isReplay) {
      setReplayRecorder(null);
    } else {
      bus.liveRecorder.clear();
      setRefreshTick((t) => t + 1);
    }
  };

  const handleExport = () => {
    const snap = activeRecorder.exportSnapshot(
      `cypilot_rec_${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`
    );
    bus.savedRecordings.push(snap);
    setActiveExport(snap);
    setExportModalOpen(true);
    bus.emitStatus(`exported ${ Object.keys(snap.csvFiles).length } source(s) to ${snap.name}`);
  };

  const handleLoadSnapshot = (snap: RecordingSnapshot) => {
    const loaded = Recorder.fromSnapshot(snap);
    setReplayRecorder(loaded);
    setPaused(true);
    const autoSelected = new Set<string>();
    const nextPaneMap: Record<string, number> = { ...curvePaneMap };
    for (const srcKey of loaded.sourceKeys()) {
      for (const f of loaded.fields(srcKey).slice(0, 2)) {
        const ck = `${srcKey}:${f}`;
        autoSelected.add(ck);
        if (!nextPaneMap[ck]) nextPaneMap[ck] = defaultPaneForField(f);
      }
    }
    if (autoSelected.size > 0) {
      setSelectedCurves(autoSelected);
      setCurvePaneMap(nextPaneMap);
    }
    setLoadModalOpen(false);
    bus.emitStatus(`loaded recording ${snap.name}`);
  };

  const handleShowLive = () => {
    setReplayRecorder(null);
    setPaused(false);
  };

  // Compute time-series data for all selected curves
  const plotData = useMemo(() => {
    let latest: number | null = null;
    let first: number | null = null;
    for (const k of activeRecorder.sourceKeys()) {
      const lt = activeRecorder.lastTime(k);
      const ft = activeRecorder.firstTime(k);
      if (lt !== null && (latest === null || lt > latest)) latest = lt;
      if (ft !== null && (first === null || ft < first)) first = ft;
    }
    if (latest === null || first === null) {
      return {
        minX: -spanSec,
        maxX: 0,
        curves: [] as {
          id: string;
          curveKey: string;
          pane: number;
          color: string;
          points: { x: number; y: number }[];
          lastValue: number | null;
        }[],
        visibleMarkers: [] as { x: number; text: string }[],
      };
    }

    const origin = isReplay ? first : latest;
    const since = isReplay ? null : latest - spanSec;
    const minX = isReplay ? 0 : -spanSec;
    const maxX = isReplay ? Math.max(1, latest - first) : 0;

    const curves: {
      id: string;
      curveKey: string;
      pane: number;
      color: string;
      points: { x: number; y: number }[];
      lastValue: number | null;
    }[] = [];

    const curveList = Array.from(selectedCurves);
    curveList.forEach((curveKey, idx) => {
      const sep = curveKey.lastIndexOf(':');
      if (sep <= 0) return;
      const sourceKey = curveKey.slice(0, sep);
      const fieldName = curveKey.slice(sep + 1);
      const [times, values] = activeRecorder.series(sourceKey, fieldName, since);
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i < times.length; i++) {
        if (!Number.isNaN(values[i])) {
          const x = times[i] - origin;
          const y = values[i];
          pts.push({ x, y });
        }
      }
      const rawPane = curvePaneMap[curveKey] ?? defaultPaneForField(fieldName);
      const effectivePane = plotLayout === 1 ? 1 : plotLayout === 2 ? ((rawPane - 1) % 2) + 1 : rawPane;
      curves.push({
        id: `${sourceKey}/${fieldName}`,
        curveKey,
        pane: effectivePane,
        color: CURVE_COLORS[idx % CURVE_COLORS.length],
        points: pts,
        lastValue: pts.length > 0 ? pts[pts.length - 1].y : null,
      });
    });

    const visibleMarkers = activeRecorder.markers
      .filter(([stamp]) => since === null || stamp >= since)
      .slice(-25)
      .map(([stamp, text]) => ({
        x: stamp - origin,
        text,
      }));

    return { minX, maxX, curves, visibleMarkers };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeRecorder,
    isReplay,
    spanSec,
    selectedCurves,
    curvePaneMap,
    plotLayout,
    paused ? 0 : bus.liveRecorder.count('10/telemetry'),
  ]);

  const subscribedCount = bus.getSubscribedKeys().length;
  const stateLabel = isReplay
    ? 'replay'
    : subscribedCount > 0
      ? `live, ${subscribedCount} source${subscribedCount !== 1 ? 's' : ''}`
      : 'live';

  const paneNumbers = useMemo(() => {
    if (plotLayout === 1) return [1];
    if (plotLayout === 2) return [1, 2];
    return [1, 2, 3, 4];
  }, [plotLayout]);

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Top Plot Controls */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-xs">
        <button
          type="button"
          onClick={() => setSidebarCollapsed((c) => !c)}
          className="rounded border border-slate-300 bg-white px-2.5 py-1 font-mono text-[11px] font-semibold text-slate-800 hover:bg-slate-100"
          title="Collapse or expand channel selector sidebar to give plots maximum screen area"
        >
          {sidebarCollapsed ? 'Show Channels' : 'Hide Channels'}
        </button>

        <div className="h-4 w-px bg-slate-300" />

        {/* Multi-Plot Layout Selector */}
        <div className="flex items-center gap-1">
          <span className="font-medium text-slate-700">Plots:</span>
          {([1, 2, 4] as MultiPlotLayout[]).map((count) => (
            <button
              key={count}
              type="button"
              onClick={() => setPlotLayout(count)}
              className={`rounded border px-2 py-0.5 font-mono text-[11px] ${
                plotLayout === count
                  ? 'border-blue-600 bg-blue-600 font-semibold text-white'
                  : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
              }`}
              title={
                count === 1
                  ? 'Single plot canvas (shared Y axis)'
                  : count === 2
                    ? '2 stacked synchronized plots with independent Y axes'
                    : '2×2 quad plot grid (4 independent Y axes, synchronized time cursor)'
              }
            >
              {count === 1 ? '1 Plot' : count === 2 ? '2 Stacked' : '2×2 Quad'}
            </button>
          ))}
        </div>

        <div className="h-4 w-px bg-slate-300" />

        <span className="font-medium text-slate-700">Window</span>
        <div className="flex items-center gap-1">
          <input
            type="number"
            min={0.5}
            max={600}
            step={1}
            value={spanSec}
            onChange={(e) => setSpanSec(Math.max(0.5, Number(e.target.value)))}
            title="Width of the time window that follows the latest sample"
            className="w-16 rounded border border-slate-300 bg-white px-2 py-0.5 font-mono text-xs tabular-nums"
          />
          <span className="font-mono text-slate-500">s</span>
        </div>

        <label
          className="flex cursor-pointer items-center gap-1.5 text-slate-700"
          title="Stop following; the recorder keeps recording"
        >
          <input
            type="checkbox"
            disabled={isReplay}
            checked={paused}
            onChange={(e) => setPaused(e.target.checked)}
            className="rounded border-slate-300"
          />
          Pause
        </label>

        <button
          type="button"
          onClick={handleClear}
          className="rounded border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-100"
        >
          Clear
        </button>

        <button
          type="button"
          onClick={handleExport}
          title="One CSV per source and recording.json into a directory / snapshot"
          className="rounded border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-100"
        >
          Export...
        </button>

        <button
          type="button"
          onClick={() => setLoadModalOpen(true)}
          className="rounded border border-slate-300 bg-white px-2.5 py-1 font-medium text-slate-700 hover:bg-slate-100"
        >
          Load... ({bus.savedRecordings.length})
        </button>

        {isReplay && (
          <button
            type="button"
            onClick={handleShowLive}
            title="Back to the live channels after a loaded recording"
            className="rounded bg-blue-600 px-2.5 py-1 font-medium text-white hover:bg-blue-700"
          >
            Live
          </button>
        )}

        <div className="ml-auto font-mono text-xs font-semibold text-slate-700">
          {stateLabel}
        </div>
      </div>

      {/* Main Split: Collapsible Left Source/Field Tree + Right Multi-Plot Grid */}
      <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
        {!sidebarCollapsed && (
          <div className="max-h-44 w-full shrink-0 overflow-y-auto border-b border-slate-200 bg-slate-50/40 p-2.5 text-xs lg:max-h-none lg:w-64 lg:border-b-0 lg:border-r">
            <div className="mb-2 flex items-center justify-between font-semibold text-slate-700">
              <span>Source / field</span>
              <span className="font-mono text-[10px] text-slate-400">Pane P1..P4</span>
            </div>
            {availableSources.length === 0 ? (
              <p className="text-slate-400">Connect to a bus to discover typed published subjects.</p>
            ) : (
              <div className="space-y-2">
                {availableSources.map((src) => {
                  const subbed = isReplay ? true : bus.isSourceSubscribed(src.key);
                  const fields = activeRecorder.fields(src.key);
                  return (
                    <div key={src.key} className="rounded border border-slate-200 bg-white p-2">
                      <label
                        className="flex cursor-pointer items-center gap-1.5 font-mono font-semibold text-slate-800"
                        title={src.typeName}
                      >
                        <input
                          type="checkbox"
                          disabled={isReplay}
                          checked={subbed}
                          onChange={(e) => toggleSource(src.key, e.target.checked)}
                          className="rounded border-slate-300 text-blue-600"
                        />
                        <span>
                          {src.key}{' '}
                          <span className="font-normal text-slate-500">(sub {src.subject})</span>
                        </span>
                      </label>

                      {fields.length > 0 && (
                        <div className="mt-1.5 space-y-1 border-t border-slate-100 pt-1.5 pl-2">
                          {fields.map((f) => {
                            const curveKey = `${src.key}:${f}`;
                            const checked = selectedCurves.has(curveKey);
                            const assignedPane =
                              curvePaneMap[curveKey] ?? defaultPaneForField(f);
                            return (
                              <div
                                key={f}
                                className="flex items-center justify-between gap-1 font-mono text-[11px]"
                              >
                                <label className="flex cursor-pointer items-center gap-1.5 text-slate-700 hover:text-slate-900 truncate">
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={(e) => toggleCurve(src.key, f, e.target.checked)}
                                    className="rounded border-slate-300 text-blue-600"
                                  />
                                  <span className="truncate">{f}</span>
                                </label>
                                {checked && plotLayout > 1 && (
                                  <select
                                    value={assignedPane}
                                    onChange={(e) => setCurvePane(curveKey, Number(e.target.value))}
                                    className="rounded border border-slate-200 bg-slate-50 px-1 py-0 text-[10px] text-slate-700"
                                    title="Assign signal to Plot Pane 1..4"
                                  >
                                    <option value={1}>P1</option>
                                    <option value={2}>P2</option>
                                    {plotLayout === 4 && <option value={3}>P3</option>}
                                    {plotLayout === 4 && <option value={4}>P4</option>}
                                  </select>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Multi-Plot SVG Workspace */}
        <div
          className={`grid flex-1 gap-2.5 overflow-y-auto p-2.5 ${
            plotLayout === 1
              ? 'grid-cols-1 grid-rows-1'
              : plotLayout === 2
                ? 'grid-cols-1 grid-rows-2'
                : 'grid-cols-1 md:grid-cols-2 md:grid-rows-2'
          }`}
        >
          {paneNumbers.map((paneNum) => {
            const paneCurves = plotData.curves.filter((c) => c.pane === paneNum);
            const width = 920;
            const height = plotLayout === 1 ? 440 : 230;
            const padLeft = 52;
            const padRight = 18;
            const padTop = 18;
            const padBottom = 26;
            const plotW = width - padLeft - padRight;
            const plotH = height - padTop - padBottom;

            let minY = Infinity;
            let maxY = -Infinity;
            for (const c of paneCurves) {
              for (const pt of c.points) {
                if (pt.y < minY) minY = pt.y;
                if (pt.y > maxY) maxY = pt.y;
              }
            }
            if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
              minY = -1;
              maxY = 5;
            } else if (Math.abs(maxY - minY) < 1e-6) {
              minY -= 1;
              maxY += 1;
            } else {
              const pad = (maxY - minY) * 0.12;
              minY -= pad;
              maxY += pad;
            }

            const toSvgX = (x: number) =>
              padLeft +
              ((x - plotData.minX) / Math.max(1e-6, plotData.maxX - plotData.minX)) * plotW;
            const toSvgY = (y: number) =>
              padTop + plotH - ((y - minY) / Math.max(1e-6, maxY - minY)) * plotH;

            return (
              <div
                key={paneNum}
                className="flex min-h-[180px] flex-col rounded border border-slate-200 bg-white p-2"
              >
                {/* Per-Pane Legend */}
                <div className="mb-1 flex flex-wrap items-center justify-between gap-2 px-1 text-xs">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="rounded border border-slate-300 bg-slate-100 px-1.5 py-0 font-mono text-[10px] font-bold text-slate-700">
                      Plot {paneNum}
                    </span>
                    {paneCurves.length === 0 ? (
                      <span className="font-mono text-[11px] text-slate-400">
                        No signals assigned to P{paneNum}
                      </span>
                    ) : (
                      paneCurves.map((c) => (
                        <div key={c.id} className="flex items-center gap-1.5 font-mono text-[11px]">
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-xs"
                            style={{ backgroundColor: c.color }}
                          />
                          <span className="font-medium text-slate-800">{c.id}</span>
                          {c.lastValue !== null && (
                            <span className="tabular-nums text-slate-500">
                              = {c.lastValue.toFixed(3)}
                            </span>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="relative flex-1">
                  <svg
                    viewBox={`0 0 ${width} ${height}`}
                    className="h-full w-full cursor-crosshair select-none"
                    onMouseMove={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const relX = ((e.clientX - rect.left) / rect.width) * width;
                      if (relX >= padLeft && relX <= width - padRight) {
                        setHoverXRatio((relX - padLeft) / plotW);
                      } else {
                        setHoverXRatio(null);
                      }
                    }}
                    onMouseLeave={() => setHoverXRatio(null)}
                  >
                    {/* Y Grid lines */}
                    {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
                      const y = padTop + frac * plotH;
                      const val = maxY - frac * (maxY - minY);
                      return (
                        <g key={`ygrid:${frac}`}>
                          <line
                            x1={padLeft}
                            y1={y}
                            x2={width - padRight}
                            y2={y}
                            className="stroke-slate-200 dark:stroke-slate-800"
                            strokeWidth={1}
                          />
                          <text
                            x={padLeft - 6}
                            y={y + 4}
                            textAnchor="end"
                            className="fill-slate-500 font-mono text-[10px]"
                          >
                            {val.toFixed(1)}
                          </text>
                        </g>
                      );
                    })}

                    {/* X Grid lines */}
                    {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
                      const x = padLeft + frac * plotW;
                      const val = plotData.minX + frac * (plotData.maxX - plotData.minX);
                      return (
                        <g key={`xgrid:${frac}`}>
                          <line
                            x1={x}
                            y1={padTop}
                            x2={x}
                            y2={height - padBottom}
                            className="stroke-slate-200 dark:stroke-slate-800"
                            strokeWidth={1}
                          />
                          <text
                            x={x}
                            y={height - padBottom + 15}
                            textAnchor="middle"
                            className="fill-slate-500 font-mono text-[10px]"
                          >
                            {val.toFixed(1)} s
                          </text>
                        </g>
                      );
                    })}

                    {/* Event markers */}
                    {plotData.visibleMarkers.map((m, idx) => {
                      const x = toSvgX(m.x);
                      if (x < padLeft || x > width - padRight) return null;
                      return (
                        <g key={`marker:${idx}`}>
                          <line
                            x1={x}
                            y1={padTop}
                            x2={x}
                            y2={height - padBottom}
                            stroke="#94a3b8"
                            strokeDasharray="3 3"
                            strokeWidth={1}
                          />
                        </g>
                      );
                    })}

                    {/* Polylines for curves in this pane */}
                    {paneCurves.map((c) => {
                      if (c.points.length < 2) return null;
                      const d = c.points
                        .map(
                          (pt, i) =>
                            `${i === 0 ? 'M' : 'L'} ${toSvgX(pt.x).toFixed(1)} ${toSvgY(pt.y).toFixed(1)}`
                        )
                        .join(' ');
                      return (
                        <path
                          key={c.id}
                          d={d}
                          fill="none"
                          stroke={c.color}
                          strokeWidth={1.75}
                        />
                      );
                    })}

                    {/* Synchronized Hover Cursor across all subplots */}
                    {hoverXRatio !== null && (
                      <g>
                        <line
                          x1={padLeft + hoverXRatio * plotW}
                          y1={padTop}
                          x2={padLeft + hoverXRatio * plotW}
                          y2={height - padBottom}
                          stroke="#64748b"
                          strokeWidth={1}
                        />
                        <text
                          x={Math.min(width - padRight - 60, padLeft + hoverXRatio * plotW + 6)}
                          y={padTop + 12}
                          className="fill-slate-700 font-mono text-[10px] font-semibold"
                        >
                          t ={' '}
                          {(
                            plotData.minX +
                            hoverXRatio * (plotData.maxX - plotData.minX)
                          ).toFixed(2)}{' '}
                          s
                        </text>
                      </g>
                    )}
                  </svg>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Export Snapshot Inspector Modal */}
      {exportModalOpen && activeExport && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded border border-slate-300 bg-white p-4 shadow-lg">
            <div className="flex items-center justify-between border-b border-slate-200 pb-2.5">
              <h3 className="text-sm font-semibold text-slate-900">
                Exported Recording Snapshot: <code>{activeExport.name}</code>
              </h3>
              <button
                type="button"
                onClick={() => setExportModalOpen(false)}
                className="text-xs font-medium text-slate-500 hover:text-slate-800"
              >
                Close
              </button>
            </div>

            <div className="mt-3 flex-1 space-y-3 overflow-y-auto text-xs">
              <div>
                <div className="font-mono font-semibold text-slate-700">recording.json</div>
                <pre className="mt-1 max-h-40 overflow-auto rounded border border-slate-200 bg-slate-50 p-2.5 font-mono text-[11px] text-slate-800">
                  {JSON.stringify(activeExport.meta, null, 2)}
                </pre>
              </div>

              {Object.entries(activeExport.csvFiles).map(([filename, csvText]) => (
                <div key={filename}>
                  <div className="font-mono font-semibold text-slate-700">{filename}</div>
                  <pre className="mt-1 max-h-36 overflow-auto rounded border border-slate-200 bg-slate-50 p-2.5 font-mono text-[11px] text-slate-800">
                    {csvText.split('\n').slice(0, 15).join('\n')}
                  </pre>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Load Recording Snapshot Modal */}
      {loadModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded border border-slate-300 bg-white p-4 shadow-lg">
            <h3 className="text-sm font-semibold text-slate-900">Load Recording for Replay</h3>
            <div className="mt-3 space-y-2 text-xs">
              {bus.savedRecordings.length === 0 ? (
                <p className="text-slate-500">
                  No recordings exported yet. Click <strong>Export...</strong> in the plot toolbar
                  first.
                </p>
              ) : (
                bus.savedRecordings.map((snap, i) => (
                  <button
                    key={`${snap.name}:${i}`}
                    type="button"
                    onClick={() => handleLoadSnapshot(snap)}
                    className="flex w-full items-center justify-between rounded border border-slate-200 px-3 py-2 text-left font-mono hover:bg-slate-50"
                  >
                    <span className="font-semibold text-slate-800">{snap.name}</span>
                    <span className="text-[11px] text-slate-500">
                      {Object.keys(snap.csvFiles).length} CSV file(s)
                    </span>
                  </button>
                ))
              )}
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => setLoadModalOpen(false)}
                className="rounded border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
