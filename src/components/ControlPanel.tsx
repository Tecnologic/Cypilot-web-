// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useMemo, useState } from 'react';
import {
  COMMANDS,
  CypilotBusEngine,
  DriveTarget,
  NodeSummary,
  SETPOINT_UNITS,
  SetpointMode,
  setpointComponents,
} from '../core/busEngine';
import { Chip, CHIP_COLORS } from '../core/status';

interface ControlPanelProps {
  bus: CypilotBusEngine;
  node: NodeSummary | null;
}

export const ControlPanel: React.FC<ControlPanelProps> = ({ bus, node }) => {
  const [selectedMode, setSelectedMode] = useState<SetpointMode>(SetpointMode.CURRENT);
  const [val0, setVal0] = useState<number>(0);
  const [val1, setVal1] = useState<number>(2.0);
  const [rampSec, setRampSec] = useState<number>(0.5);
  const [confirmRestartOpen, setConfirmRestartOpen] = useState(false);

  const target: DriveTarget | null = useMemo(() => {
    if (!node || !node.isUnimoc || !bus.isConnected) return null;
    try {
      return bus.findTarget(node.nodeId);
    } catch {
      return null;
    }
  }, [bus, node, node?.vendorCode]);

  const availableModes = useMemo(() => {
    if (!target) return [];
    return (Object.keys(target.setpoints) as SetpointMode[]).filter(
      (m) => target.setpoints[m] !== undefined
    );
  }, [target]);

  useEffect(() => {
    if (availableModes.length > 0 && !availableModes.includes(selectedMode)) {
      setSelectedMode(availableModes[0]);
    }
  }, [availableModes, selectedMode]);

  const chips = useMemo(() => new Set(node?.chips ?? []), [node]);
  const engaged = chips.has(Chip.ENGAGED);
  const controllable = target !== null && !chips.has(Chip.LOCAL_CONTROL);
  const canRecover =
    chips.has(Chip.E_STOP) ||
    chips.has(Chip.TRIPPED) ||
    chips.has(Chip.FAULT) ||
    chips.has(Chip.BLOCKED);

  const stateDescription = useMemo(() => {
    if (!node) return '-';
    if (!node.isUnimoc) return 'not a UNIMOC drive: no control';
    const readinessText = target
      ? `readiness subject ${target.readiness}`
      : 'reading the ports ...';
    return `${node.chips.join(', ') || '-'}  (${readinessText})`;
  }, [node, target]);

  const handleEnable = () => {
    if (!target || !node) return;
    try {
      bus.emitStatus(`node ${target.nodeId}: enabling ...`, false);
      bus.engage(target);
      bus.emitStatus(`node ${target.nodeId}: enabled`);
    } catch (err) {
      bus.emitStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDisable = async () => {
    if (!target) return;
    try {
      await bus.disengage(target.nodeId, rampSec);
      bus.emitStatus(`node ${target.nodeId}: disabled`);
    } catch (err) {
      bus.emitStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSendSetpoint = (overrideZero = false) => {
    if (!target) return;
    const count = setpointComponents(selectedMode);
    const chosen = overrideZero
      ? new Array<number>(count).fill(0)
      : count === 2
        ? [val0, val1]
        : [val0];
    try {
      bus.setSetpoint(target, selectedMode, chosen, rampSec);
      const modeLabel = selectedMode.replace('_setpoint', '');
      const text = chosen.map((v) => Number(v.toPrecision(6))).join(', ');
      bus.emitStatus(`node ${target.nodeId}: ${modeLabel} = ${text}`);
    } catch (err) {
      bus.emitStatus(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRecover = () => {
    if (!node) return;
    if (chips.has(Chip.E_STOP)) {
      setConfirmRestartOpen(true);
      return;
    }
    const res = bus.recoverNode(node.nodeId, { allowRestart: false });
    bus.emitStatus(`node ${node.nodeId}: ${res.steps.join('; ')}`);
  };

  const handleConfirmRestartRecover = () => {
    setConfirmRestartOpen(false);
    if (!node) return;
    const res = bus.recoverNode(node.nodeId, { allowRestart: true });
    bus.emitStatus(`node ${node.nodeId}: ${res.steps.join('; ')}`);
  };

  const labels = SETPOINT_UNITS[selectedMode] ?? [];
  const activeSp =
    target && target.setpoints[selectedMode] !== undefined
      ? bus.getActiveSetpoint(selectedMode, target.setpoints[selectedMode]!)
      : null;

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto bg-white p-4">
      <div className="rounded border border-slate-200 bg-slate-50/70 p-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              {node ? `Node ${node.nodeId}: ${node.name || '?'}` : 'No node selected'}
            </h3>
            <p
              className="mt-1 font-mono text-xs"
              style={
                node && node.chips.length > 0
                  ? { color: CHIP_COLORS[node.chips[0]], fontWeight: 600 }
                  : { color: '#475569' }
              }
            >
              {stateDescription}
            </p>
          </div>

          {node?.isUnimoc && (
            <div className="flex items-center gap-1.5 text-xs">
              <button
                type="button"
                onClick={() => {
                  bus.executeCommand(node.nodeId, COMMANDS['emergency-stop']);
                  bus.emitStatus(`node ${node.nodeId}: EMERGENCY_STOP latched`);
                }}
                className="rounded border border-red-200 bg-red-50 px-2.5 py-1 font-mono text-[11px] font-medium text-[#c62828] hover:bg-red-100"
                title="Latch emergency stop (bit 5) on this node to test recovery"
              >
                Latch E-Stop
              </button>
              <button
                type="button"
                onClick={() => {
                  const reg = bus.readRegister(node.nodeId, 'unimoc.sim.dc_link_voltage');
                  if (reg.value.kind !== 'empty') {
                    bus.writeRegister(node.nodeId, 'unimoc.sim.dc_link_voltage', reg.value.constructor === Object ? reg.value : new (reg.value.constructor as any)('real32', [59.0]));
                    bus.emitStatus(`node ${node.nodeId}: injected 59 V overvoltage trip`);
                  }
                }}
                className="rounded border border-amber-200 bg-amber-50 px-2.5 py-1 font-mono text-[11px] font-medium text-amber-800 hover:bg-amber-100"
                title="Set unimoc.sim.dc_link_voltage = 59 V (> 58 V max) to latch an overvoltage trip"
              >
                Simulate Overvoltage Trip (59 V)
              </button>
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!controllable || engaged}
            onClick={handleEnable}
            title="Publish ENGAGED on the drive's readiness subject while this window lives"
            className="rounded bg-[#2e7d32] px-4 py-1.5 text-xs font-semibold text-white hover:bg-green-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Enable
          </button>

          <button
            type="button"
            disabled={!controllable || !engaged}
            onClick={handleDisable}
            title="Ramp the setpoint to zero, then STANDBY"
            className="rounded border border-slate-300 bg-white px-4 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Disable
          </button>

          <button
            type="button"
            disabled={!canRecover}
            onClick={handleRecover}
            title="Clear a trip (STANDBY) or a latched emergency stop (restart)"
            className="rounded border border-amber-600 bg-amber-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Recover
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Setpoints GroupBox */}
        <div className="rounded border border-slate-200 bg-white p-4 lg:col-span-7">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2">
            <h4 className="text-xs font-semibold text-slate-800">
              Setpoint (shared: every engaged drive on the same subject follows it)
            </h4>
            {activeSp && (
              <span className="font-mono text-xs text-blue-700">
                Present output: {activeSp.value.map((v) => v.toFixed(3)).join(', ')}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 items-center gap-y-2.5 sm:grid-cols-[130px_1fr] sm:gap-y-3 text-xs">
            <label className="font-medium text-slate-700">Mode</label>
            <select
              disabled={availableModes.length === 0}
              value={selectedMode}
              onChange={(e) => setSelectedMode(e.target.value as SetpointMode)}
              className="rounded border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none disabled:bg-slate-100"
            >
              {availableModes.map((mode) => (
                <option key={mode} value={mode}>
                  {mode.replace('_setpoint', '')} (subject {target?.setpoints[mode]})
                </option>
              ))}
            </select>

            {labels[0] && (
              <>
                <label className="font-mono text-slate-700">{labels[0]}</label>
                <input
                  type="number"
                  step="0.25"
                  value={val0}
                  onChange={(e) => setVal0(Number(e.target.value))}
                  className="rounded border border-slate-300 px-2.5 py-1.5 font-mono text-xs tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none"
                />
              </>
            )}

            {labels[1] && (
              <>
                <label className="font-mono text-slate-700">{labels[1]}</label>
                <input
                  type="number"
                  step="0.25"
                  value={val1}
                  onChange={(e) => setVal1(Number(e.target.value))}
                  className="rounded border border-slate-300 px-2.5 py-1.5 font-mono text-xs tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none"
                />
              </>
            )}

            <label className="font-medium text-slate-700">Ramp</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={60}
                step="0.1"
                value={rampSec}
                onChange={(e) => setRampSec(Math.max(0, Number(e.target.value)))}
                className="w-32 rounded border border-slate-300 px-2.5 py-1.5 font-mono text-xs tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none"
              />
              <span className="font-mono text-slate-500">s</span>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!controllable || !engaged || availableModes.length === 0}
              onClick={() => handleSendSetpoint(false)}
              className="rounded bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send setpoint
            </button>

            <button
              type="button"
              disabled={!controllable || !engaged || availableModes.length === 0}
              onClick={() => handleSendSetpoint(true)}
              className="rounded border border-slate-300 bg-white px-4 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Zero
            </button>
          </div>
        </div>

        {/* Safety & Watchdog Reference Card */}
        <div className="rounded border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600 lg:col-span-5">
          <div className="font-semibold text-slate-800">
            Safety &amp; Keep-Alive Rules (`cypilot.core.control`)
          </div>
          <ul className="mt-2 space-y-2 text-[11px] leading-relaxed">
            <li>
              · <strong>Per-node readiness:</strong> Enabling publishes <code>ENGAGED (3)</code> on{' '}
              <code>1024 + node_id</code> at 20 Hz (every 50 ms).
            </li>
            <li>
              · <strong>UI Watchdog (0.3 s):</strong> The UI thread feeds the controller every 100 ms.
              If stalled &gt; 300 ms, the bus thread immediately publishes <code>SLEEP (0)</code> 3× and zeroes all setpoints.
            </li>
            <li>
              · <strong>Preconditions:</strong> Refuses to enable if E-stop or trip is latched, external enable is missing, local control is active (Node 20 e-bike), or another master publishes on the readiness subject.
            </li>
          </ul>
        </div>
      </div>

      {/* E-Stop Restart Confirmation Dialog */}
      {confirmRestartOpen && node && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="w-full max-w-md rounded border border-slate-300 bg-white p-4 shadow-lg">
            <h3 className="text-sm font-semibold text-slate-900">Restart the drive?</h3>
            <p className="mt-2 text-xs text-slate-600">
              The emergency stop of node {node.nodeId} is latched until a restart. Restart the drive
              now?
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmRestartOpen(false)}
                className="rounded border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                No
              </button>
              <button
                type="button"
                onClick={handleConfirmRestartRecover}
                className="rounded bg-blue-600 px-3.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
              >
                Yes, Restart
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
