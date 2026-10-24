// SPDX-License-Identifier: Apache-2.0
import React, { useState } from 'react';
import { CypilotBusEngine } from '../core/busEngine';

interface CliPanelProps {
  bus: CypilotBusEngine;
}

interface CliEntry {
  id: number;
  command: string;
  exitCode: number;
  output: string;
}

const PRESET_COMMANDS = [
  'cypilot-ctl nodes',
  'cypilot-ctl regs 10 unimoc.motor.*',
  'cypilot-ctl get 10 unimoc.motor.limits.i_max',
  'cypilot-ctl set 10 unimoc.motor.limits.i_max 12.5',
  'cypilot-ctl set 10 unimoc.motor.limits.i_max 5000',
  'cypilot-ctl caps 10',
  'cypilot-ctl profile diff 10 high_torque_24A.json',
  'cypilot-ctl run 10 --current 0,2.5',
  'cypilot-ctl stop',
  'cypilot-ctl sim 10 status',
  'cypilot-ctl --json nodes',
];

export const CliPanel: React.FC<CliPanelProps> = ({ bus }) => {
  const [input, setInput] = useState<string>('cypilot-ctl nodes');
  const [history, setHistory] = useState<CliEntry[]>(() => {
    const initial = bus.executeCli('cypilot-ctl nodes');
    return [
      {
        id: 1,
        command: 'cypilot-ctl nodes',
        exitCode: initial.exitCode,
        output: initial.output,
      },
    ];
  });

  const runCommand = (cmdText: string) => {
    const trimmed = cmdText.trim();
    if (!trimmed) return;
    const res = bus.executeCli(trimmed);
    setHistory((prev) => [
      ...prev,
      {
        id: Date.now() + Math.random(),
        command: trimmed,
        exitCode: res.exitCode,
        output: res.output,
      },
    ]);
  };

  return (
    <div className="flex h-full flex-col bg-white p-4 text-xs">
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="mr-1 font-semibold text-slate-700">Quick CLI:</span>
        {PRESET_COMMANDS.map((cmd) => (
          <button
            key={cmd}
            type="button"
            onClick={() => {
              setInput(cmd);
              runCommand(cmd);
            }}
            className="rounded border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-700 hover:border-blue-400 hover:bg-blue-50"
          >
            {cmd.replace('cypilot-ctl ', '')}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          runCommand(input);
        }}
        className="mb-3 flex items-center gap-2"
      >
        <span className="font-mono font-semibold text-slate-500">$</span>
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="cypilot-ctl regs 10 unimoc.motor.*"
          className="flex-1 rounded border border-slate-300 bg-white px-3 py-1.5 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
        />
        <button
          type="submit"
          className="rounded bg-slate-900 px-4 py-1.5 font-semibold text-white hover:bg-slate-800"
        >
          Run
        </button>
        <button
          type="button"
          onClick={() => setHistory([])}
          className="rounded border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-100"
        >
          Clear
        </button>
      </form>

      <div className="flex-1 overflow-auto rounded border border-slate-800 bg-[#0B0E17] p-3.5 font-mono text-xs text-slate-200">
        {history.map((entry) => (
          <div key={entry.id} className="mb-4 last:mb-0">
            <div className="flex items-center justify-between text-slate-400">
              <span>$ {entry.command}</span>
              <span
                className={
                  entry.exitCode === 0 ? 'text-emerald-400' : 'text-rose-400'
                }
              >
                exit {entry.exitCode}
              </span>
            </div>
            <pre className="mt-1 whitespace-pre-wrap text-slate-100">{entry.output}</pre>
          </div>
        ))}
      </div>
    </div>
  );
};
