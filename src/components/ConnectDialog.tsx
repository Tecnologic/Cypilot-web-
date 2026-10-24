// SPDX-License-Identifier: Apache-2.0
import React, { useState } from 'react';
import {
  CLASSIC_MTU,
  DEFAULT_LOCAL_NODE_ID,
  FD_MTU,
  InterfaceSpec,
  discoverInterfaces,
  parseBitrateText,
  parseInterface,
} from '../core/transport';

interface ConnectDialogProps {
  open: boolean;
  onClose: () => void;
  onConnect: (spec: InterfaceSpec, localNodeId: number) => void;
}

const MTU_CHOICES: { label: string; value: number | null }[] = [
  { label: 'Default of the interface', value: null },
  { label: `Classic CAN (${CLASSIC_MTU})`, value: CLASSIC_MTU },
  { label: `CAN FD (${FD_MTU})`, value: FD_MTU },
];

export const ConnectDialog: React.FC<ConnectDialogProps> = ({ open, onClose, onConnect }) => {
  const presets = discoverInterfaces();
  const [ifaceText, setIfaceText] = useState<string>(
    () => localStorage.getItem('cypilot.connect.interface') || 'socketcan:vcan0'
  );
  const [mtuChoice, setMtuChoice] = useState<string>(
    () => localStorage.getItem('cypilot.connect.mtu') || 'default'
  );
  const [bitrateText, setBitrateText] = useState<string>(
    () => localStorage.getItem('cypilot.connect.bitrate') || ''
  );
  const [localNodeId, setLocalNodeId] = useState<number>(() => {
    const saved = localStorage.getItem('cypilot.connect.local_node_id');
    return saved ? Number(saved) : DEFAULT_LOCAL_NODE_ID;
  });
  const [error, setError] = useState<string>('');

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const mtu =
        mtuChoice === 'default' ? null : mtuChoice === '8' ? CLASSIC_MTU : FD_MTU;
      const bitrate = parseBitrateText(bitrateText);
      if (localNodeId < 0 || localNodeId > 127 || !Number.isInteger(localNodeId)) {
        throw new Error(`invalid CAN node-ID ${localNodeId} (expected 0..127)`);
      }
      const spec = parseInterface(ifaceText, { mtu, bitrate });
      localStorage.setItem('cypilot.connect.interface', ifaceText);
      localStorage.setItem('cypilot.connect.mtu', mtuChoice);
      localStorage.setItem('cypilot.connect.bitrate', bitrateText);
      localStorage.setItem('cypilot.connect.local_node_id', String(localNodeId));
      onConnect(spec, localNodeId);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-lg rounded border border-slate-300 bg-white shadow-lg">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-100 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-slate-900">Connect to a CAN bus</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-xs font-medium text-slate-500 hover:text-slate-800"
          >
            Esc
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3.5 p-4 text-sm">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">Interface</label>
            <input
              type="text"
              value={ifaceText}
              onChange={(e) => setIfaceText(e.target.value)}
              placeholder="socketcan:vcan0, slcan:/dev/pts/1, slcan:COM5, pcan:PCAN_USBBUS1"
              className="w-full rounded border border-slate-300 px-2.5 py-1.5 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
            />
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {presets.map((p) => (
                <button
                  key={p.text}
                  type="button"
                  title={p.description}
                  onClick={() => {
                    setIfaceText(p.text);
                    setError('');
                  }}
                  className={`rounded border px-2 py-0.5 font-mono text-xs transition-colors ${
                    ifaceText === p.text
                      ? 'border-blue-600 bg-blue-50 text-blue-800'
                      : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {p.text}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">CAN MTU</label>
              <select
                value={mtuChoice}
                onChange={(e) => setMtuChoice(e.target.value)}
                className="w-full rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
              >
                {MTU_CHOICES.map((c) => (
                  <option key={String(c.value)} value={c.value === null ? 'default' : String(c.value)}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-slate-700">Local node-ID</label>
              <input
                type="number"
                min={0}
                max={127}
                value={localNodeId}
                onChange={(e) => setLocalNodeId(Number(e.target.value))}
                className="w-full rounded border border-slate-300 px-2.5 py-1.5 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-700">Bit rates</label>
            <input
              type="text"
              value={bitrateText}
              onChange={(e) => setBitrateText(e.target.value)}
              placeholder="1000000/1000000 (for adapters that need it)"
              className="w-full rounded border border-slate-300 px-2.5 py-1.5 font-mono text-xs text-slate-900 focus:border-blue-600 focus:outline-none"
            />
          </div>

          {error && (
            <div className="rounded border border-red-200 bg-red-50 px-3 py-2 font-mono text-xs text-[#c62828]">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-slate-200 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              OK
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
