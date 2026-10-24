// SPDX-License-Identifier: Apache-2.0
import React, { useMemo, useState } from 'react';
import { CypilotBusEngine, NodeSummary } from '../core/busEngine';
import {
  CYMON_DRIVE_VARIABLES,
  CymonCaptureSetup,
  CymonCaptureShot,
  CymonMultiNodeSyncMode,
  CymonTriggerEdge,
} from '../core/cymonScope';
import { RegisterValue } from '../core/registers';

interface CymonExpertPanelProps {
  bus: CypilotBusEngine;
  node: NodeSummary | null;
}

const TRACE_COLORS = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#a855f7', // purple
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#84cc16', // lime
];

export const CymonExpertPanel: React.FC<CymonExpertPanelProps> = ({ bus, node }) => {
  const [subMode, setSubMode] = useState<'scope' | 'raw' | 'git'>('scope');
  const [controlsCollapsed, setControlsCollapsed] = useState(false);

  // Scope setup state
  const unimocNodes = useMemo(
    () => bus.nodes().filter((n) => n.isUnimoc),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bus, bus.nodes().length]
  );

  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<number>>(new Set([10, 11]));
  const [selectedVars, setSelectedVars] = useState<Set<string>>(
    new Set(['foc.i_q_ref', 'foc.i_q', 'foc.v_q'])
  );
  const [sampleDepth, setSampleDepth] = useState<number>(512);
  const [decimation, setDecimation] = useState<number>(1); // 1 = 16 kHz (62.5 us)
  const [preTriggerPercent, setPreTriggerPercent] = useState<number>(25);
  const [triggerNodeId, setTriggerNodeId] = useState<number>(node?.nodeId ?? 10);
  const [triggerVariable, setTriggerVariable] = useState<string>('foc.i_q_ref');
  const [triggerEdge, setTriggerEdge] = useState<CymonTriggerEdge>('rising');
  const [triggerLevel, setTriggerLevel] = useState<number>(2.0);
  const [triggerHysteresis, setTriggerHysteresis] = useState<number>(0.25);
  const [syncMode, setSyncMode] = useState<CymonMultiNodeSyncMode>('shared_trigger_event');
  const [injectStep, setInjectStep] = useState<boolean>(true);
  const [stepAmplitude, setStepAmplitude] = useState<number>(6.0);
  const [splitByUnit, setSplitByUnit] = useState<boolean>(true);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  // Raw subject/service expert state
  const [rawSubjectId, setRawSubjectId] = useState<number>(107);
  const [rawSubjectType, setRawSubjectType] = useState<string>(
    'unimoc.drive.CurrentSetpoint.0.1'
  );
  const [rawSubjectPayload, setRawSubjectPayload] = useState<string>(
    '{"i_d": 0.0, "i_q": 4.5}'
  );
  const [rawServiceNodeId, setRawServiceNodeId] = useState<number>(10);
  const [rawServiceId, setRawServiceId] = useState<number>(121);
  const [rawServiceType, setRawServiceType] = useState<string>('cymon.GetBufferInfo.0.1');
  const [rawServicePayload, setRawServicePayload] = useState<string>('{}');
  const [lastServiceResponse, setLastServiceResponse] = useState<string>('');
  const [sessionTelemetryHz, setSessionTelemetryHz] = useState<number>(100);

  // Seed an initial 16 kHz triggered capture shot if none exists yet
  const activeShot: CymonCaptureShot | null = useMemo(() => {
    if (bus.savedScopeShots.length > 0) {
      return bus.savedScopeShots[0];
    }
    if (!bus.isConnected) return null;
    const defaultSetup: CymonCaptureSetup = {
      nodeIds: [10, 11],
      channelsByNode: {
        10: ['foc.i_q_ref', 'foc.i_q', 'foc.v_q'],
        11: ['foc.i_q', 'foc.v_q'],
      },
      sampleDepth: 512,
      decimation: 1,
      preTriggerPercent: 25,
      triggerNodeId: 10,
      triggerVariable: 'foc.i_q_ref',
      triggerEdge: 'rising',
      triggerLevel: 2.0,
      triggerHysteresis: 0.25,
      syncMode: 'shared_trigger_event',
      injectTestStepOnArm: true,
      testStepAmplitude: 6.0,
    };
    return bus.captureCymonScopeShot(defaultSetup);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bus, bus.savedScopeShots.length, bus.isConnected]);

  const activeNodeList = Array.from(selectedNodeIds).sort((a, b) => a - b);
  const triggerAlignment = bus.checkSharedCymonTriggerSubject(activeNodeList);

  const handleArmAndCapture = () => {
    const nodeIds = activeNodeList.length > 0 ? activeNodeList : [node?.nodeId ?? 10];
    const vars = Array.from(selectedVars);
    const channelsByNode: Record<number, string[]> = {};
    for (const id of nodeIds) {
      channelsByNode[id] = vars.slice(0, 8);
    }
    const setup: CymonCaptureSetup = {
      nodeIds,
      channelsByNode,
      sampleDepth,
      decimation,
      preTriggerPercent,
      triggerNodeId: nodeIds.includes(triggerNodeId) ? triggerNodeId : nodeIds[0],
      triggerVariable,
      triggerEdge,
      triggerLevel,
      triggerHysteresis,
      syncMode,
      injectTestStepOnArm: injectStep,
      testStepAmplitude: stepAmplitude,
    };
    bus.captureCymonScopeShot(setup);
  };

  const handleExportShotJson = () => {
    if (!activeShot) return;
    const blob = new Blob([JSON.stringify(activeShot, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeShot.id}_16khz.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleApplyTelemetryBoost = (rateHz: number) => {
    for (const n of unimocNodes) {
      bus.writeRegister(n.nodeId, 'unimoc.telemetry.rate', new RegisterValue('natural16', [rateHz]));
    }
    bus.emitStatus(
      `session telemetry rate set to ${rateHz} Hz on nodes ${unimocNodes.map((n) => n.nodeId).join(', ')}`
    );
  };

  // Group captured traces into either 1 combined pane or unit-separated panes (Currents [A] vs Voltages [V] vs Speed/Other)
  const scopePanes = useMemo(() => {
    if (!activeShot || activeShot.traces.length === 0) return [];
    if (!splitByUnit) {
      return [{ title: 'All Captured Channels', traces: activeShot.traces }];
    }
    const currentTraces = activeShot.traces.filter((t) => t.unit === 'A');
    const voltageTraces = activeShot.traces.filter((t) => t.unit === 'V');
    const otherTraces = activeShot.traces.filter((t) => t.unit !== 'A' && t.unit !== 'V');
    const panes: { title: string; traces: typeof activeShot.traces }[] = [];
    if (currentTraces.length > 0) panes.push({ title: 'FOC Currents [A]', traces: currentTraces });
    if (voltageTraces.length > 0) panes.push({ title: 'Voltages [V]', traces: voltageTraces });
    if (otherTraces.length > 0) panes.push({ title: 'Mechanical / PWM', traces: otherTraces });
    return panes;
  }, [activeShot, splitByUnit]);

  return (
    <div className="flex h-full flex-col bg-white text-xs">
      {/* Top Expert Sub-Navigation Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-xs font-bold text-slate-900">
            cymon Expert &amp; 16 kHz Scope
          </span>
          <div className="mx-1 h-4 w-px bg-slate-300" />
          <button
            type="button"
            onClick={() => setSubMode('scope')}
            className={`rounded border px-2.5 py-1 font-mono text-[11px] transition-colors ${
              subMode === 'scope'
                ? 'border-blue-600 bg-blue-600 font-semibold text-white'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
            }`}
          >
            16 kHz Triggered Capture (`cymon.srv.*`)
          </button>
          <button
            type="button"
            onClick={() => setSubMode('raw')}
            className={`rounded border px-2.5 py-1 font-mono text-[11px] transition-colors ${
              subMode === 'raw'
                ? 'border-blue-600 bg-blue-600 font-semibold text-white'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
            }`}
          >
            Raw Subject / Service &amp; Rate Boost
          </button>
          <button
            type="button"
            onClick={() => setSubMode('git')}
            className={`rounded border px-2.5 py-1 font-mono text-[11px] transition-colors ${
              subMode === 'git'
                ? 'border-blue-600 bg-blue-600 font-semibold text-white'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
            }`}
          >
            Git Branch &amp; Multi-Plot Architecture
          </button>
        </div>

        {subMode === 'scope' && (
          <div className="flex items-center gap-2">
            <label className="flex cursor-pointer items-center gap-1.5 font-mono text-[11px] text-slate-700">
              <input
                type="checkbox"
                checked={splitByUnit}
                onChange={(e) => setSplitByUnit(e.target.checked)}
                className="rounded border-slate-300"
              />
              <span>Split Subplots by Unit ([A] / [V])</span>
            </label>
            <button
              type="button"
              onClick={() => setControlsCollapsed((c) => !c)}
              className="rounded border border-slate-300 bg-white px-2.5 py-1 font-mono text-[11px] font-medium text-slate-700 hover:bg-slate-100"
            >
              {controlsCollapsed ? 'Show Trigger Setup' : 'Maximize Scope Canvas'}
            </button>
          </div>
        )}
      </div>

      {/* MODE 1: 16 kHz Triggered Scope Capture */}
      {subMode === 'scope' && (
        <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
          {/* Collapsible Left Setup Sidebar */}
          {!controlsCollapsed && (
            <div className="max-h-64 w-full shrink-0 space-y-3 overflow-y-auto border-b border-slate-200 bg-slate-50/60 p-3 lg:max-h-none lg:w-80 lg:border-b-0 lg:border-r">
              {/* 1. Target Nodes */}
              <div>
                <div className="mb-1.5 flex items-center justify-between font-semibold text-slate-800">
                  <span>1. Capture Nodes (cymon.SetupCapture)</span>
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedNodeIds(new Set(unimocNodes.map((n) => n.nodeId)))
                    }
                    className="font-mono text-[10px] text-blue-700 hover:underline"
                  >
                    All Drives
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {unimocNodes.map((n) => {
                    const active = selectedNodeIds.has(n.nodeId);
                    return (
                      <button
                        key={n.nodeId}
                        type="button"
                        onClick={() => {
                          setSelectedNodeIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(n.nodeId)) next.delete(n.nodeId);
                            else next.add(n.nodeId);
                            return next;
                          });
                        }}
                        className={`rounded border px-2 py-1 font-mono text-[11px] ${
                          active
                            ? 'border-blue-600 bg-blue-600 font-semibold text-white'
                            : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        #{n.nodeId} {n.name}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 2. High-Speed Control Loop Variables */}
              <div>
                <div className="mb-1 font-semibold text-slate-800">
                  2. 16 kHz Variables ({selectedVars.size}/8 max)
                </div>
                <div className="max-h-40 space-y-1 overflow-y-auto rounded border border-slate-200 bg-white p-2 font-mono text-[11px]">
                  {CYMON_DRIVE_VARIABLES.map((v) => {
                    const checked = selectedVars.has(v.name);
                    return (
                      <label
                        key={v.name}
                        className="flex cursor-pointer items-center justify-between gap-1 hover:bg-slate-50"
                        title={v.description}
                      >
                        <span className="flex items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setSelectedVars((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked && next.size < 8) next.add(v.name);
                                else next.delete(v.name);
                                return next;
                              });
                            }}
                            className="rounded border-slate-300 text-blue-600"
                          />
                          <span className="text-slate-900">{v.name}</span>
                        </span>
                        <span className="text-[10px] text-slate-400">{v.unit || v.type}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* 3. Buffer Depth, Prescaler & Pre-Trigger */}
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="block text-[10px] font-semibold text-slate-600">Samples</label>
                  <select
                    value={sampleDepth}
                    onChange={(e) => setSampleDepth(Number(e.target.value))}
                    className="mt-0.5 w-full rounded border border-slate-300 bg-white px-1.5 py-1 font-mono text-[11px]"
                  >
                    <option value={256}>256</option>
                    <option value={512}>512</option>
                    <option value={1024}>1024</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-slate-600">Rate</label>
                  <select
                    value={decimation}
                    onChange={(e) => setDecimation(Number(e.target.value))}
                    className="mt-0.5 w-full rounded border border-slate-300 bg-white px-1.5 py-1 font-mono text-[11px]"
                  >
                    <option value={1}>16 kHz (1×)</option>
                    <option value={2}>8 kHz (2×)</option>
                    <option value={4}>4 kHz (4×)</option>
                    <option value={16}>1 kHz (16×)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] font-semibold text-slate-600">Pre-Trig</label>
                  <select
                    value={preTriggerPercent}
                    onChange={(e) => setPreTriggerPercent(Number(e.target.value))}
                    className="mt-0.5 w-full rounded border border-slate-300 bg-white px-1.5 py-1 font-mono text-[11px]"
                  >
                    <option value={10}>10%</option>
                    <option value={25}>25%</option>
                    <option value={50}>50%</option>
                    <option value={75}>75%</option>
                  </select>
                </div>
              </div>

              {/* 4. Trigger Condition (cymon.ArmTrigger) */}
              <div className="space-y-2 rounded border border-slate-200 bg-white p-2.5">
                <div className="font-semibold text-slate-800">
                  3. Trigger Condition (`cymon.ArmTrigger`)
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] text-slate-500">Trigger Node</label>
                    <select
                      value={triggerNodeId}
                      onChange={(e) => setTriggerNodeId(Number(e.target.value))}
                      className="mt-0.5 w-full rounded border border-slate-300 bg-white px-1.5 py-1 font-mono text-[11px]"
                    >
                      {unimocNodes.map((n) => (
                        <option key={n.nodeId} value={n.nodeId}>
                          #{n.nodeId} {n.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500">Variable</label>
                    <select
                      value={triggerVariable}
                      onChange={(e) => setTriggerVariable(e.target.value)}
                      className="mt-0.5 w-full rounded border border-slate-300 bg-white px-1.5 py-1 font-mono text-[11px]"
                    >
                      {CYMON_DRIVE_VARIABLES.map((v) => (
                        <option key={v.name} value={v.name}>
                          {v.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500">Edge Mode</label>
                    <select
                      value={triggerEdge}
                      onChange={(e) => setTriggerEdge(e.target.value as CymonTriggerEdge)}
                      className="mt-0.5 w-full rounded border border-slate-300 bg-white px-1.5 py-1 font-mono text-[11px]"
                    >
                      <option value="rising">Rising Edge</option>
                      <option value="falling">Falling Edge</option>
                      <option value="hysteresis">Hysteresis</option>
                      <option value="immediate">Immediate</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500">Level</label>
                    <input
                      type="number"
                      step="0.5"
                      value={triggerLevel}
                      onChange={(e) => setTriggerLevel(Number(e.target.value))}
                      className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-[11px]"
                    />
                  </div>
                </div>

                {triggerEdge === 'hysteresis' && (
                  <div>
                    <label className="block text-[10px] text-slate-500">Hysteresis Band</label>
                    <input
                      type="number"
                      step="0.1"
                      value={triggerHysteresis}
                      onChange={(e) => setTriggerHysteresis(Number(e.target.value))}
                      className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-[11px]"
                    />
                  </div>
                )}

                <div>
                  <label className="block text-[10px] text-slate-500">
                    Multi-Node Alignment (Section 8.2)
                  </label>
                  <select
                    value={syncMode}
                    onChange={(e) => setSyncMode(e.target.value as CymonMultiNodeSyncMode)}
                    className="mt-0.5 w-full rounded border border-slate-300 bg-white px-1.5 py-1 font-mono text-[11px]"
                  >
                    <option value="shared_trigger_event">
                      Shared cymon.TriggerEvent (subject {triggerAlignment.subjectId ?? 520})
                    </option>
                    <option value="per_node_signal">
                      Trigger each node on its own signal (0 ms skew)
                    </option>
                  </select>
                  {!triggerAlignment.aligned && activeNodeList.length > 1 && (
                    <button
                      type="button"
                      onClick={() => bus.configureSharedCymonTriggerSubject(activeNodeList, 520)}
                      className="mt-1 w-full rounded border border-amber-300 bg-amber-50 px-2 py-1 font-mono text-[10px] font-semibold text-amber-900 hover:bg-amber-100"
                    >
                      Configure Shared Trigger Subject 520 on All Nodes
                    </button>
                  )}
                </div>

                <label className="flex cursor-pointer items-center justify-between gap-2 pt-1 text-[11px] text-slate-700">
                  <span className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={injectStep}
                      onChange={(e) => setInjectStep(e.target.checked)}
                      className="rounded border-slate-300 text-blue-600"
                    />
                    <span>Inject Step on Arm</span>
                  </span>
                  <input
                    type="number"
                    step="0.5"
                    value={stepAmplitude}
                    onChange={(e) => setStepAmplitude(Number(e.target.value))}
                    className="w-20 rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-[11px]"
                    title="Step amplitude [A]"
                  />
                </label>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!bus.isConnected}
                  onClick={handleArmAndCapture}
                  className="flex-1 rounded bg-[#2e7d32] px-3 py-2 font-mono text-xs font-bold text-white hover:bg-green-800 disabled:opacity-40"
                >
                  Arm &amp; Capture Shot
                </button>
                <button
                  type="button"
                  disabled={!activeShot}
                  onClick={handleExportShotJson}
                  className="rounded border border-slate-300 bg-white px-2.5 py-2 font-mono text-[11px] font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
                >
                  Export
                </button>
              </div>
            </div>
          )}

          {/* Right Full-Space High-Speed Scope Canvas */}
          <div className="flex flex-1 flex-col overflow-hidden p-3">
            {!activeShot ? (
              <div className="flex flex-1 items-center justify-center text-slate-400">
                Click &ldquo;Arm &amp; Capture Shot&rdquo; to trigger a 16 kHz high-speed capture.
              </div>
            ) : (
              <>
                {/* Scope Shot Metadata Bar */}
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 bg-slate-50 px-3 py-1.5 font-mono text-[11px]">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-bold text-emerald-600">COMPLETE</span>
                    <span>
                      {(activeShot.effectiveSampleRateHz / 1000).toFixed(1)} kHz (Δt{' '}
                      {activeShot.samplePeriodUs} µs)
                    </span>
                    <span>·</span>
                    <span>{activeShot.setup.sampleDepth} samples/ch</span>
                    <span>·</span>
                    <span>
                      Trigger: #{activeShot.setup.triggerNodeId} {activeShot.setup.triggerVariable}{' '}
                      ({activeShot.setup.triggerEdge} @ {activeShot.setup.triggerLevel})
                    </span>
                    {activeShot.uncertaintyBandMs && (
                      <>
                        <span>·</span>
                        <span className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0 text-[10px] text-amber-800">
                          Bus Trigger Skew Band: +{activeShot.uncertaintyBandMs[0]}..+
                          {activeShot.uncertaintyBandMs[1]} ms
                        </span>
                      </>
                    )}
                  </div>
                  <span className="text-slate-500">
                    Read time: {activeShot.busTransferTimeSec}s
                  </span>
                </div>

                {/* Multi-Pane Synchronized Oscilloscope Subplots */}
                <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto">
                  {scopePanes.map((pane, paneIdx) => {
                    const svgW = 1000;
                    const svgH = scopePanes.length === 1 ? 420 : 210;
                    const padL = 56;
                    const padR = 20;
                    const padT = 18;
                    const padB = 26;
                    const plotW = svgW - padL - padR;
                    const plotH = svgH - padT - padB;

                    const refTime = pane.traces[0]?.timeMs ?? [-10, 30];
                    const minX = refTime[0] ?? -10;
                    const maxX = refTime[refTime.length - 1] ?? 30;

                    let minY = Infinity;
                    let maxY = -Infinity;
                    for (const tr of pane.traces) {
                      for (const v of tr.values) {
                        if (v < minY) minY = v;
                        if (v > maxY) maxY = v;
                      }
                    }
                    if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
                      minY = -1;
                      maxY = 5;
                    } else if (Math.abs(maxY - minY) < 1e-4) {
                      minY -= 1;
                      maxY += 1;
                    } else {
                      const pad = (maxY - minY) * 0.12;
                      minY -= pad;
                      maxY += pad;
                    }

                    const toX = (tMs: number) =>
                      padL + ((tMs - minX) / Math.max(1e-6, maxX - minX)) * plotW;
                    const toY = (val: number) =>
                      padT + plotH - ((val - minY) / Math.max(1e-6, maxY - minY)) * plotH;

                    const zeroTimeX = toX(0);

                    return (
                      <div
                        key={pane.title}
                        className="flex flex-1 flex-col rounded border border-slate-200 bg-white p-2"
                      >
                        <div className="mb-1 flex flex-wrap items-center justify-between gap-2 px-1 font-mono text-[11px]">
                          <span className="font-semibold text-slate-800">{pane.title}</span>
                          <div className="flex flex-wrap items-center gap-3">
                            {pane.traces.map((tr, tIdx) => {
                              const color =
                                TRACE_COLORS[(paneIdx * 3 + tIdx) % TRACE_COLORS.length];
                              const cursorVal =
                                hoverIndex !== null && tr.values[hoverIndex] !== undefined
                                  ? tr.values[hoverIndex]
                                  : tr.values[activeShot.triggerSampleIndex + 10];
                              return (
                                <span key={`${tr.nodeId}:${tr.variable}`} className="flex items-center gap-1">
                                  <span
                                    className="inline-block h-2 w-2 rounded-xs"
                                    style={{ backgroundColor: color }}
                                  />
                                  <span className="text-slate-800">
                                    #{tr.nodeId} {tr.variable}
                                  </span>
                                  {cursorVal !== undefined && (
                                    <span className="tabular-nums text-slate-500">
                                      ={cursorVal.toFixed(3)}
                                      {tr.unit}
                                    </span>
                                  )}
                                </span>
                              );
                            })}
                          </div>
                        </div>

                        <div className="relative flex-1">
                          <svg
                            viewBox={`0 0 ${svgW} ${svgH}`}
                            className="h-full w-full cursor-crosshair select-none"
                            onMouseMove={(e) => {
                              const rect = e.currentTarget.getBoundingClientRect();
                              const relX = ((e.clientX - rect.left) / rect.width) * svgW;
                              if (relX >= padL && relX <= svgW - padR) {
                                const frac = (relX - padL) / plotW;
                                const idx = Math.min(
                                  refTime.length - 1,
                                  Math.max(0, Math.round(frac * (refTime.length - 1)))
                                );
                                setHoverIndex(idx);
                              } else {
                                setHoverIndex(null);
                              }
                            }}
                            onMouseLeave={() => setHoverIndex(null)}
                          >
                            {/* Horizontal Y gridlines */}
                            {[0, 0.25, 0.5, 0.75, 1].map((f) => {
                              const y = padT + f * plotH;
                              const val = maxY - f * (maxY - minY);
                              return (
                                <g key={f}>
                                  <line
                                    x1={padL}
                                    y1={y}
                                    x2={svgW - padR}
                                    y2={y}
                                    className="stroke-slate-200 dark:stroke-slate-800"
                                    strokeWidth={1}
                                  />
                                  <text
                                    x={padL - 6}
                                    y={y + 3}
                                    textAnchor="end"
                                    className="fill-slate-500 font-mono text-[10px]"
                                  >
                                    {val.toFixed(2)}
                                  </text>
                                </g>
                              );
                            })}

                            {/* Vertical X gridlines (ms relative to trigger) */}
                            {[0, 0.2, 0.4, 0.6, 0.8, 1].map((f) => {
                              const x = padL + f * plotW;
                              const tVal = minX + f * (maxX - minX);
                              return (
                                <g key={f}>
                                  <line
                                    x1={x}
                                    y1={padT}
                                    x2={x}
                                    y2={svgH - padB}
                                    className="stroke-slate-200 dark:stroke-slate-800"
                                    strokeWidth={1}
                                  />
                                  <text
                                    x={x}
                                    y={svgH - padB + 15}
                                    textAnchor="middle"
                                    className="fill-slate-500 font-mono text-[10px]"
                                  >
                                    {tVal >= 0 ? `+${tVal.toFixed(2)}` : tVal.toFixed(2)} ms
                                  </text>
                                </g>
                              );
                            })}

                            {/* Shared Trigger Bus Uncertainty Band (1.15 .. 1.6 ms) */}
                            {activeShot.uncertaintyBandMs && (
                              <rect
                                x={toX(activeShot.uncertaintyBandMs[0])}
                                y={padT}
                                width={Math.max(
                                  2,
                                  toX(activeShot.uncertaintyBandMs[1]) -
                                    toX(activeShot.uncertaintyBandMs[0])
                                )}
                                height={plotH}
                                fill="rgba(245, 158, 11, 0.18)"
                              />
                            )}

                            {/* Trigger Instant t = 0.000 ms Line */}
                            {zeroTimeX >= padL && zeroTimeX <= svgW - padR && (
                              <g>
                                <line
                                  x1={zeroTimeX}
                                  y1={padT}
                                  x2={zeroTimeX}
                                  y2={svgH - padB}
                                  stroke="#ef4444"
                                  strokeDasharray="4 3"
                                  strokeWidth={1.5}
                                />
                                <text
                                  x={zeroTimeX + 4}
                                  y={padT + 10}
                                  className="fill-red-500 font-mono text-[9px] font-bold"
                                >
                                  TRIG 0.00ms
                                </text>
                              </g>
                            )}

                            {/* Traces */}
                            {pane.traces.map((tr, tIdx) => {
                              const color =
                                TRACE_COLORS[(paneIdx * 3 + tIdx) % TRACE_COLORS.length];
                              const d = tr.values
                                .map(
                                  (v, i) =>
                                    `${i === 0 ? 'M' : 'L'} ${toX(tr.timeMs[i]).toFixed(1)} ${toY(v).toFixed(1)}`
                                )
                                .join(' ');
                              return (
                                <path
                                  key={`${tr.nodeId}:${tr.variable}`}
                                  d={d}
                                  fill="none"
                                  stroke={color}
                                  strokeWidth={1.75}
                                />
                              );
                            })}

                            {/* Synchronized Hover Cursor */}
                            {hoverIndex !== null && refTime[hoverIndex] !== undefined && (
                              <g>
                                <line
                                  x1={toX(refTime[hoverIndex])}
                                  y1={padT}
                                  x2={toX(refTime[hoverIndex])}
                                  y2={svgH - padB}
                                  stroke="#64748b"
                                  strokeWidth={1}
                                />
                                <text
                                  x={Math.min(svgW - padR - 70, toX(refTime[hoverIndex]) + 6)}
                                  y={padT + 12}
                                  className="fill-slate-700 font-mono text-[10px] font-semibold"
                                >
                                  t = {refTime[hoverIndex].toFixed(3)} ms (sample #{hoverIndex})
                                </text>
                              </g>
                            )}
                          </svg>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* MODE 2: Raw Cyphal Subject Publisher, Service Caller & Telemetry Rate Booster */}
      {subMode === 'raw' && (
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            {/* Raw Subject Publisher */}
            <div className="rounded border border-slate-200 bg-slate-50/70 p-3.5">
              <h3 className="font-semibold text-slate-900">
                1. Raw Cyphal Subject Publisher (`cymon` by hand)
              </h3>
              <p className="mt-1 text-[11px] text-slate-500">
                Publish any arbitrary DSDL subject frame onto the bus and inject its numeric fields
                into the live recorder.
              </p>
              <div className="mt-3 space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] text-slate-500">Subject-ID</label>
                    <input
                      type="number"
                      min={0}
                      max={8191}
                      value={rawSubjectId}
                      onChange={(e) => setRawSubjectId(Number(e.target.value))}
                      className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500">DSDL Type</label>
                    <input
                      type="text"
                      value={rawSubjectType}
                      onChange={(e) => setRawSubjectType(e.target.value)}
                      className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] text-slate-500">Payload (JSON)</label>
                  <textarea
                    rows={3}
                    value={rawSubjectPayload}
                    onChange={(e) => setRawSubjectPayload(e.target.value)}
                    className="mt-0.5 w-full rounded border border-slate-300 bg-white p-2 font-mono text-xs"
                  />
                </div>
                <button
                  type="button"
                  disabled={!bus.isConnected}
                  onClick={() =>
                    bus.publishRawSubject(rawSubjectId, rawSubjectType, rawSubjectPayload)
                  }
                  className="w-full rounded bg-blue-600 px-3 py-1.5 font-semibold text-white hover:bg-blue-700 disabled:opacity-40"
                >
                  Publish Subject Frame
                </button>
              </div>
            </div>

            {/* Raw Service Caller */}
            <div className="rounded border border-slate-200 bg-slate-50/70 p-3.5">
              <h3 className="font-semibold text-slate-900">
                2. Raw Cyphal Service Caller (`uavcan.srv.*`)
              </h3>
              <p className="mt-1 text-[11px] text-slate-500">
                Invoke any Cyphal service (`cymon.GetVariableList`, `cymon.GetBufferInfo`,
                `uavcan.node.ExecuteCommand`) directly on a target node.
              </p>
              <div className="mt-3 space-y-2">
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-[10px] text-slate-500">Target Node</label>
                    <select
                      value={rawServiceNodeId}
                      onChange={(e) => setRawServiceNodeId(Number(e.target.value))}
                      className="mt-0.5 w-full rounded border border-slate-300 bg-white px-1.5 py-1 font-mono text-xs"
                    >
                      {bus.nodes().map((n) => (
                        <option key={n.nodeId} value={n.nodeId}>
                          #{n.nodeId} {n.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500">Service-ID</label>
                    <select
                      value={rawServiceId}
                      onChange={(e) => {
                        const id = Number(e.target.value);
                        setRawServiceId(id);
                        if (id === 120) setRawServiceType('cymon.GetVariableList.0.1');
                        if (id === 121) setRawServiceType('cymon.GetBufferInfo.0.1');
                        if (id === 435) setRawServiceType('uavcan.node.ExecuteCommand.1.3');
                      }}
                      className="mt-0.5 w-full rounded border border-slate-300 bg-white px-1.5 py-1 font-mono text-xs"
                    >
                      <option value={120}>120 (GetVariableList)</option>
                      <option value={121}>121 (GetBufferInfo)</option>
                      <option value={435}>435 (ExecuteCommand)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500">Request JSON</label>
                    <input
                      type="text"
                      value={rawServicePayload}
                      onChange={(e) => setRawServicePayload(e.target.value)}
                      className="mt-0.5 w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs"
                    />
                  </div>
                </div>
                <button
                  type="button"
                  disabled={!bus.isConnected}
                  onClick={() => {
                    const res = bus.callRawService(
                      rawServiceNodeId,
                      rawServiceId,
                      rawServiceType,
                      rawServicePayload
                    );
                    setLastServiceResponse(res.responseJson);
                  }}
                  className="w-full rounded bg-slate-900 px-3 py-1.5 font-semibold text-white hover:bg-slate-800 disabled:opacity-40"
                >
                  Send Service Request
                </button>
                {lastServiceResponse && (
                  <pre className="max-h-28 overflow-auto rounded border border-slate-200 bg-white p-2 font-mono text-[10px] text-slate-800">
                    {lastServiceResponse}
                  </pre>
                )}
              </div>
            </div>

            {/* Session Telemetry Rate Booster (Section 8.1) */}
            <div className="rounded border border-slate-200 bg-slate-50/70 p-3.5">
              <h3 className="font-semibold text-slate-900">
                3. Session Telemetry Rate Boost (`unimoc.telemetry.rate`)
              </h3>
              <p className="mt-1 text-[11px] text-slate-500">
                Temporarily raise <code>unimoc.telemetry.rate</code> across all UNIMOC drives for
                higher-resolution live plots without storing to flash, and restore to 20 Hz when
                done (Section 8.1).
              </p>
              <div className="mt-3 flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={200}
                  value={sessionTelemetryHz}
                  onChange={(e) => setSessionTelemetryHz(Number(e.target.value))}
                  className="w-24 rounded border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs"
                />
                <span className="font-mono text-slate-500">Hz</span>
                <button
                  type="button"
                  onClick={() => handleApplyTelemetryBoost(sessionTelemetryHz)}
                  className="rounded bg-blue-600 px-3 py-1.5 font-semibold text-white hover:bg-blue-700"
                >
                  Apply Rate
                </button>
                <button
                  type="button"
                  onClick={() => handleApplyTelemetryBoost(20)}
                  className="rounded border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-100"
                >
                  Restore 20 Hz
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* MODE 3: Git Branch & Multi-Plot Architecture Guide */}
      {subMode === 'git' && (
        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded border border-slate-200 bg-slate-50/70 p-4">
              <h3 className="text-sm font-semibold text-slate-900">
                How to Keep Your Original Python `main` Branch &amp; Compare on a New Branch
              </h3>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
                Following your <code>AGENTS.md</code> rule (
                <em>&ldquo;Work on an own branch; never commit to or push main&rdquo;</em>), this
                workspace is initialized on its own Git branch{' '}
                <code className="font-semibold text-blue-700">feat/web-cypilot-cymon</code>. Your
                original Python + PySide6 code on <code>origin/main</code> in{' '}
                <code>Tecnologic/cypilot</code> remains completely untouched until you choose where
                to push.
              </p>
              <pre className="mt-3 overflow-x-auto rounded border border-slate-300 bg-white p-3 font-mono text-[11px] leading-relaxed text-slate-800">
{`# 1. In your local Tecnologic/cypilot clone (or when exporting from AI Studio):
git checkout -b feat/web-cypilot-cymon

# 2. Push this implementation to a separate branch on GitHub (never main):
git push -u origin feat/web-cypilot-cymon

# 3. Compare or run both side-by-side using git worktree:
git worktree add ../cypilot-python main
# Now ../cypilot-python has your original Python/PySide6 code on main,
# and your current directory has the web + Cymon scope implementation!`}
              </pre>
            </div>

            <div className="rounded border border-slate-200 bg-slate-50/70 p-4">
              <h3 className="text-sm font-semibold text-slate-900">
                Multi-Plot Architecture: In-App Subplots Grid + Multi-Window Sync
              </h3>
              <ul className="mt-2 space-y-2 text-xs leading-relaxed text-slate-600">
                <li>
                  · <strong>1. In-Window Multi-Plot Grid (No extra tabs needed):</strong> In the{' '}
                  <strong>Plot</strong> tab, you can switch between <strong>1 Pane</strong>,{' '}
                  <strong>2 Stacked Panes</strong>, or a <strong>2×2 Quad Grid (4 Plots)</strong>{' '}
                  and assign any signal (`i_q`, `speed`, `v_dc`, `torque`) to Pane 1..4. Each pane
                  has its own independent auto-scaled Y-axis while sharing a synchronized time base
                  and crosshair cursor.
                </li>
                <li>
                  · <strong>2. Full-Canvas Maximize:</strong> Click{' '}
                  <strong>Hide Channels / Maximize Plot</strong> in the Plot or Cymon Scope toolbar
                  to collapse the channel tree and log dock so the plots use 100% of the viewport.
                </li>
                <li>
                  · <strong>3. Multi-Monitor / Pop-Out Window Sync:</strong> If you open a second
                  browser window on a second monitor, <code>BroadcastChannel(&apos;cypilot-bus-sync&apos;)</code>{' '}
                  streams scope shots and bus events across windows without opening a second CAN
                  adapter connection.
                </li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
