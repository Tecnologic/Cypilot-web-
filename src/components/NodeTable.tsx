// SPDX-License-Identifier: Apache-2.0
import React from 'react';
import { Capability, Port } from '../core/capabilities';
import { NodeSummary } from '../core/busEngine';
import {
  CHIP_COLORS,
  HEALTH_COLORS,
  formatUptime,
  healthName,
  modeName,
} from '../core/status';

interface NodeTableProps {
  nodes: NodeSummary[];
  selectedNodeId: number | null;
  onSelectNode: (nodeId: number) => void;
  capabilities: Capability[];
  ports: Port[];
  onOpenTab?: (tab: 'registers' | 'control' | 'simulation') => void;
}

export const NodeTable: React.FC<NodeTableProps> = ({
  nodes,
  selectedNodeId,
  onSelectNode,
  capabilities,
  ports,
  onOpenTab,
}) => {
  const selectedNode = nodes.find((n) => n.nodeId === selectedNodeId) ?? null;

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-white p-2.5 sm:p-4">
      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Left / Main Area on Desktop: Full Bus Node Overview Table */}
        <div className="flex flex-col rounded border border-slate-200 bg-white lg:col-span-7 xl:col-span-8">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
            <span className="text-xs font-semibold text-slate-800">
              Discovered Cyphal Nodes ({nodes.length})
            </span>
            <span className="font-mono text-[11px] text-slate-500">
              uavcan.node.Heartbeat.1.0 · 1 Hz + GetInfo.1.0
            </span>
          </div>

          <div className="flex-1 overflow-x-auto">
            <table className="w-full min-w-[540px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/80 text-[11px] font-semibold text-slate-600">
                  <th className="px-3 py-2 font-mono">ID</th>
                  <th className="px-3 py-2">Name / Role</th>
                  <th className="px-2.5 py-2 font-mono">SW</th>
                  <th className="hidden px-2.5 py-2 font-mono xl:table-cell">HW</th>
                  <th className="px-2.5 py-2">Health</th>
                  <th className="px-2.5 py-2">Mode</th>
                  <th className="px-2.5 py-2 text-right font-mono">Uptime</th>
                  <th className="hidden px-2.5 py-2 font-mono md:table-cell">VSSC</th>
                  <th className="px-3 py-2">State</th>
                  {onOpenTab && <th className="px-3 py-2 text-right">Inspect</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {nodes.length === 0 ? (
                  <tr>
                    <td
                      colSpan={onOpenTab ? 10 : 9}
                      className="px-4 py-8 text-center text-xs text-slate-400"
                    >
                      No nodes online. Click <strong className="text-slate-600">Connect...</strong>{' '}
                      in the toolbar to open a CAN bus.
                    </td>
                  </tr>
                ) : (
                  nodes.map((node) => {
                    const isSelected = node.nodeId === selectedNodeId;
                    const healthColor = HEALTH_COLORS[node.health];
                    const stateColor =
                      node.chips.length > 0 ? CHIP_COLORS[node.chips[0]] : undefined;
                    const swText = node.softwareVersion
                      ? `${node.softwareVersion[0]}.${node.softwareVersion[1]}`
                      : '?';
                    const hwText = node.hardwareVersion
                      ? `${node.hardwareVersion[0]}.${node.hardwareVersion[1]}`
                      : '-';
                    const stateText = node.chips.join(', ') || '-';
                    const vsscHex = `0x${node.vendorCode.toString(16).padStart(2, '0')}`;

                    return (
                      <tr
                        key={node.nodeId}
                        onClick={() => onSelectNode(node.nodeId)}
                        className={`cursor-pointer transition-colors ${
                          isSelected
                            ? 'bg-blue-50/90 text-slate-900 font-medium'
                            : 'hover:bg-slate-50 text-slate-800'
                        }`}
                      >
                        <td className="px-3 py-2.5 font-mono font-semibold tabular-nums text-slate-900">
                          {node.nodeId}
                        </td>
                        <td className="px-3 py-2.5 font-medium" title={node.name || '?'}>
                          <div className="flex items-center gap-1.5">
                            <span>{node.name || '?'}</span>
                            {node.isUnimoc && (
                              <span className="rounded border border-slate-300 bg-slate-100 px-1 py-0 font-mono text-[10px] text-slate-600">
                                UNIMOC
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-2.5 py-2.5 font-mono tabular-nums text-slate-600">
                          {swText}
                        </td>
                        <td className="hidden px-2.5 py-2.5 font-mono tabular-nums text-slate-500 xl:table-cell">
                          {hwText}
                        </td>
                        <td
                          className="px-2.5 py-2.5 font-mono"
                          style={healthColor ? { color: healthColor, fontWeight: 600 } : undefined}
                        >
                          {healthName(node.health)}
                        </td>
                        <td className="px-2.5 py-2.5 font-mono text-slate-600">
                          {modeName(node.mode)}
                        </td>
                        <td className="px-2.5 py-2.5 text-right font-mono tabular-nums text-slate-600">
                          {formatUptime(node.uptime)}
                        </td>
                        <td className="hidden px-2.5 py-2.5 font-mono tabular-nums text-slate-500 md:table-cell">
                          {vsscHex}
                        </td>
                        <td
                          className="px-3 py-2.5 font-mono"
                          style={stateColor ? { color: stateColor, fontWeight: 600 } : undefined}
                          title={
                            node.unimoc === null
                              ? 'probing whether this is a UNIMOC node'
                              : `vendor_specific_status_code: ${vsscHex}`
                          }
                        >
                          {stateText}
                        </td>
                        {onOpenTab && (
                          <td
                            className="px-3 py-2 text-right whitespace-nowrap"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => {
                                  onSelectNode(node.nodeId);
                                  onOpenTab('registers');
                                }}
                                className="rounded border border-slate-300 bg-white px-2 py-0.5 font-mono text-[10px] text-slate-700 hover:bg-slate-100"
                              >
                                Regs
                              </button>
                              {node.isUnimoc && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    onSelectNode(node.nodeId);
                                    onOpenTab('control');
                                  }}
                                  className="rounded border border-slate-300 bg-white px-2 py-0.5 font-mono text-[10px] text-slate-700 hover:bg-slate-100"
                                >
                                  Control
                                </button>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Area on Desktop / Bottom on Mobile: Selected Node Capabilities & Ports Inspector */}
        <div className="flex flex-col rounded border border-slate-200 bg-slate-50/70 p-3.5 text-xs lg:col-span-5 xl:col-span-4">
          {!selectedNode ? (
            <div className="flex flex-1 items-center justify-center py-8 text-center text-slate-400">
              Select a node in the table to inspect its discovered Cyphal capabilities and ports.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 pb-2.5">
                <div>
                  <span className="font-semibold text-slate-900">
                    Node {selectedNode.nodeId} ({selectedNode.name || '?'}) Discovery
                  </span>
                  <div className="mt-0.5 font-mono text-[11px] text-slate-500">
                    UID {selectedNode.uniqueIdHex.slice(0, 16)} · VCS{' '}
                    {selectedNode.vcsRevision
                      ? `0x${selectedNode.vcsRevision.toString(16)}`
                      : '-'}
                  </div>
                </div>
                <span className="rounded border border-slate-300 bg-white px-2 py-0.5 font-mono text-[11px] text-slate-700">
                  vendor=0x{selectedNode.vendorCode.toString(16).padStart(2, '0')}
                </span>
              </div>

              <div className="mt-3">
                <div className="text-[11px] font-semibold text-slate-700">
                  Capabilities (`cypilot.core.capabilities`)
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5 font-mono text-[11px]">
                  {capabilities.length > 0 ? (
                    capabilities.map((cap) => (
                      <span
                        key={cap}
                        className="rounded border border-slate-300 bg-white px-2 py-0.5 text-slate-800"
                      >
                        {cap}
                      </span>
                    ))
                  ) : (
                    <span className="text-slate-400">none</span>
                  )}
                </div>
              </div>

              <div className="mt-3 flex flex-1 flex-col overflow-hidden">
                <div className="mb-1.5 text-[11px] font-semibold text-slate-700">
                  Configured Subject &amp; Service Ports ({ports.length})
                </div>
                <div className="flex-1 overflow-auto rounded border border-slate-200 bg-white">
                  <table className="w-full text-left font-mono text-[11px]">
                    <thead className="sticky top-0 border-b border-slate-200 bg-slate-50 text-slate-500">
                      <tr>
                        <th className="px-2.5 py-1.5">Port</th>
                        <th className="px-2 py-1.5">Kind</th>
                        <th className="px-2 py-1.5">ID</th>
                        <th className="px-2.5 py-1.5">DSDL Type</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {ports.map((p) => (
                        <tr key={`${p.kind}.${p.name}`} className="hover:bg-slate-50">
                          <td className="px-2.5 py-1 font-medium text-slate-800">{p.name}</td>
                          <td className="px-2 py-1 text-slate-500">{p.kind}</td>
                          <td className="px-2 py-1 tabular-nums text-slate-700 whitespace-nowrap">
                            {p.portId === null
                              ? 'off'
                              : p.configured !== p.portId
                                ? `${p.portId} (node-ID)`
                                : p.portId}
                          </td>
                          <td
                            className="px-2.5 py-1 truncate max-w-[200px] text-slate-500"
                            title={p.typeName ?? '?'}
                          >
                            {p.typeName ?? '?'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
