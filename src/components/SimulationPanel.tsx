// SPDX-License-Identifier: Apache-2.0
import React, { useMemo, useState } from 'react';
import { CypilotBusEngine, NodeSummary } from '../core/busEngine';
import { Register, RegisterValue } from '../core/registers';
import { SIM_PREFIX } from '../core/simControl';

interface SimulationPanelProps {
  bus: CypilotBusEngine;
  node: NodeSummary | null;
}

export const SimulationPanel: React.FC<SimulationPanelProps> = ({ bus, node }) => {
  const [cyclesToAdvance, setCyclesToAdvance] = useState<number>(1600);
  const [refreshTick, setRefreshTick] = useState(0);

  const simStatus = useMemo(() => {
    if (!node || !bus.isConnected) return null;
    try {
      return bus.simStatus(node.nodeId);
    } catch {
      return null;
    }
  }, [bus, node, node?.uptime, refreshTick]);

  const plantInputs: Register[] = useMemo(() => {
    if (!node || !simStatus) return [];
    return bus.simPlantInputRegisters(node.nodeId);
  }, [bus, node, simStatus, refreshTick]);

  const handleSetPaused = (paused: boolean) => {
    if (!node) return;
    try {
      bus.simSetPaused(node.nodeId, paused);
      bus.emitStatus(`node ${node.nodeId}: ${paused ? 'paused' : 'running'}`);
      setRefreshTick((t) => t + 1);
    } catch (err) {
      bus.emitStatus(`node ${node.nodeId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleAdvance = () => {
    if (!node) return;
    try {
      bus.simAdvance(node.nodeId, cyclesToAdvance);
      bus.emitStatus(`node ${node.nodeId}: advanced ${cyclesToAdvance} cycles`);
      setRefreshTick((t) => t + 1);
    } catch (err) {
      bus.emitStatus(`node ${node.nodeId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleReset = () => {
    if (!node) return;
    try {
      bus.simReset(node.nodeId);
      bus.emitStatus(`node ${node.nodeId}: reset: plant at standstill, virtual time 0`);
      setRefreshTick((t) => t + 1);
    } catch (err) {
      bus.emitStatus(`node ${node.nodeId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleWriteInput = (reg: Register, rawValue: number | boolean) => {
    if (!node) return;
    const kind = reg.value.kind;
    const content =
      typeof rawValue === 'boolean'
        ? [rawValue]
        : [kind.startsWith('real') ? rawValue : Math.round(rawValue)];
    const val = new RegisterValue(kind, content);
    const res = bus.writeRegister(node.nodeId, reg.name, val);
    if (res.accepted) {
      bus.emitStatus(`${reg.name} = ${res.register.value.format()}`);
    } else {
      bus.emitStatus(`${reg.name}: rejected, the node keeps ${res.register.value.format()}`);
    }
    setRefreshTick((t) => t + 1);
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto bg-white p-4">
      <div className="rounded border border-slate-200 bg-slate-50/70 p-3.5">
        <h3 className="text-sm font-semibold text-slate-900">
          {!node
            ? 'No simulated drive selected'
            : simStatus
              ? `Node ${node.nodeId}: simulated drive`
              : `Node ${node.nodeId}: not a simulation`}
        </h3>

        <p className="mt-1 font-mono text-xs tabular-nums text-slate-700">
          {simStatus
            ? `${simStatus.paused ? 'paused' : 'running'}, cycle ${simStatus.cycleCount}, virtual time ${simStatus.virtualTime.toFixed(4)} s`
            : '-'}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!simStatus || simStatus.paused}
            onClick={() => handleSetPaused(true)}
            className="rounded border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Pause
          </button>

          <button
            type="button"
            disabled={!simStatus || !simStatus.paused}
            onClick={() => handleSetPaused(false)}
            className="rounded bg-[#2e7d32] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-green-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Run
          </button>

          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={1}
              max={1000000}
              step={1600}
              disabled={!simStatus}
              value={cyclesToAdvance}
              onChange={(e) => setCyclesToAdvance(Math.max(1, Number(e.target.value)))}
              className="w-28 rounded border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none disabled:bg-slate-100"
            />
            <span className="font-mono text-xs text-slate-500">cycles</span>
          </div>

          <button
            type="button"
            disabled={!simStatus || !simStatus.paused}
            onClick={handleAdvance}
            title="Runs the cycles of a paused simulation as fast as it can"
            className="rounded bg-blue-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Advance
          </button>

          <button
            type="button"
            disabled={!simStatus}
            onClick={handleReset}
            title="Plant to standstill, virtual time to 0, controller restarted"
            className="rounded border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Plant inputs (unimoc.sim.* registers) */}
      <div className="rounded border border-slate-200 bg-white p-4">
        <h4 className="mb-3 border-b border-slate-100 pb-2 text-xs font-semibold text-slate-800">
          Plant inputs (unimoc.sim.* registers)
        </h4>

        {!simStatus ? (
          <p className="text-xs text-slate-400">
            Select a node with <code>unimoc.sim.*</code> registers (e.g., Nodes 10–13 on{' '}
            <code>socketcan:vcan0</code> or Node 10 on <code>slcan:/dev/pts/1</code>).
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 text-xs">
            {plantInputs.map((reg) => {
              const shortLabel = reg.name.startsWith(SIM_PREFIX)
                ? reg.name.slice(SIM_PREFIX.length)
                : reg.name;
              const val = Array.isArray(reg.value.content) ? reg.value.content[0] : 0;

              return (
                <div
                  key={reg.name}
                  className="flex flex-col justify-between gap-2 rounded border border-slate-200 bg-slate-50/70 p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <label
                      className="font-mono font-semibold text-slate-800"
                      title={reg.description || reg.name}
                    >
                      {shortLabel}
                    </label>
                    {reg.unit && (
                      <span className="rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
                        {reg.unit}
                      </span>
                    )}
                  </div>

                  {reg.description && (
                    <div className="text-[11px] text-slate-500">{reg.description}</div>
                  )}

                  <div className="mt-1 flex items-center gap-2">
                    {reg.value.kind === 'bit' ? (
                      <label className="inline-flex cursor-pointer items-center gap-2">
                        <input
                          type="checkbox"
                          checked={Boolean(val)}
                          onChange={(e) => handleWriteInput(reg, e.target.checked)}
                          className="h-4 w-4 rounded border-slate-300 text-blue-600"
                        />
                        <span className="font-mono text-slate-700">
                          {Boolean(val) ? 'true (enabled)' : 'false (open / blocked)'}
                        </span>
                      </label>
                    ) : (
                      <input
                        type="number"
                        step={reg.value.kind.startsWith('real') ? '0.5' : '1'}
                        defaultValue={Number(val)}
                        key={`${reg.name}:${val}`}
                        onBlur={(e) => {
                          const num = Number(e.target.value);
                          if (!Number.isNaN(num) && num !== Number(val)) {
                            handleWriteInput(reg, num);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const num = Number((e.target as HTMLInputElement).value);
                            if (!Number.isNaN(num)) {
                              handleWriteInput(reg, num);
                            }
                          }
                        }}
                        className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs tabular-nums text-slate-900 focus:border-blue-600 focus:outline-none"
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
