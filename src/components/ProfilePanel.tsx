// SPDX-License-Identifier: Apache-2.0
import React, { useMemo, useState } from 'react';
import { COMMANDS, CypilotBusEngine, NodeSummary } from '../core/busEngine';
import {
  classifyUniqueRegister,
  createProfileFromRegisters,
  diffProfile,
  isSkippedOnLoad,
  loadProfileSync,
  profileFromJson,
  profileToJson,
} from '../core/profiles';

interface ProfilePanelProps {
  bus: CypilotBusEngine;
  node: NodeSummary | null;
}

export const ProfilePanel: React.FC<ProfilePanelProps> = ({ bus, node }) => {
  const profileNames = Array.from(bus.savedProfiles.keys());
  const [selectedProfileName, setSelectedProfileName] = useState<string>(
    profileNames[0] || 'fl_drive_default.json'
  );
  const [newProfileName, setNewProfileName] = useState<string>('drive_custom.json');
  const [includePorts, setIncludePorts] = useState<boolean>(false);
  const [includeIdentity, setIncludeIdentity] = useState<boolean>(false);
  const [storeAfterLoad, setStoreAfterLoad] = useState<boolean>(true);
  const [lastOutcome, setLastOutcome] = useState<string>('');
  const [tick, setTick] = useState(0);

  // Direct Node-to-Node Transfer state
  const allNodes = bus.nodes();
  const [transferTargetIds, setTransferTargetIds] = useState<Set<number>>(new Set([11, 12, 13]));

  const selectedProfile = bus.savedProfiles.get(selectedProfileName) ?? null;

  const registers = useMemo(() => {
    if (!node || !bus.isConnected) return [];
    try {
      return bus.scanRegisters(node.nodeId);
    } catch {
      return [];
    }
  }, [bus, node, node?.vendorCode, tick]);

  const differences = useMemo(() => {
    if (!selectedProfile || !node) return [];
    return diffProfile(selectedProfile, registers, { includePorts, includeIdentity });
  }, [selectedProfile, node, registers, includePorts, includeIdentity]);

  // Discover similar nodes on the bus for the selected source node
  const similarNodes = useMemo(() => {
    if (!node || !bus.isConnected) return [];
    const sourcePortableNames = new Set(
      registers
        .filter((r) => r.mutable && r.persistent && !classifyUniqueRegister(r.name).isUnique)
        .map((r) => r.name)
    );
    return allNodes
      .filter((other) => other.nodeId !== node.nodeId)
      .map((other) => {
        const otherRegs = bus.scanRegisters(other.nodeId);
        const shared = otherRegs.filter(
          (r) =>
            r.mutable &&
            r.persistent &&
            !classifyUniqueRegister(r.name).isUnique &&
            sourcePortableNames.has(r.name)
        ).length;
        return {
          summary: other,
          shared,
          total: sourcePortableNames.size,
        };
      })
      .filter((item) => item.shared > 0);
  }, [allNodes, bus, node, registers]);

  const excludedOnNode = useMemo(() => {
    return registers.filter((r) =>
      isSkippedOnLoad(r.name, { includePorts, includeIdentity })
    );
  }, [registers, includePorts, includeIdentity]);

  const handleSaveFromNode = (downloadToFile: boolean) => {
    if (!node) return;
    const cleanName = newProfileName.trim().endsWith('.json')
      ? newProfileName.trim()
      : `${newProfileName.trim() || `node_${node.nodeId}_settings`}.json`;
    const prof = createProfileFromRegisters(registers, {
      nodeName: node.name,
      softwareVersion: node.softwareVersion,
      vcsRevision: node.vcsRevision,
      includePorts,
      includeIdentity,
    });
    bus.savedProfiles.set(cleanName, prof);
    setSelectedProfileName(cleanName);
    setTick((t) => t + 1);

    if (downloadToFile) {
      const text = profileToJson(prof);
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = cleanName;
      a.click();
      URL.revokeObjectURL(url);
    }

    const count = Object.keys(prof.registers).length;
    const excludedCount = prof.excludedUnique?.length ?? 0;
    const msg = `Saved ${count} portable registers from Node ${node.nodeId} (${node.name}) to ${cleanName} (excluded ${excludedCount} unique/identity/port registers)`;
    setLastOutcome(msg);
    bus.emitStatus(msg);
  };

  const handleDownloadJson = () => {
    if (!selectedProfile) return;
    const text = profileToJson(selectedProfile);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = selectedProfileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleUploadJson = (e: React.ChangeEvent<HTMLInputElement>, applyImmediately: boolean) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = profileFromJson(String(reader.result));
        bus.savedProfiles.set(file.name, parsed);
        setSelectedProfileName(file.name);
        if (applyImmediately && node) {
          const res = loadProfileSync(
            parsed,
            registers,
            (name, val) => bus.writeRegister(node.nodeId, name, val),
            { includePorts, includeIdentity }
          );
          let storeText = '';
          if (storeAfterLoad && res.complete) {
            const st = bus.executeCommand(node.nodeId, COMMANDS.store);
            storeText = st === 0 ? ' · stored in flash' : ` · store refused (status ${st})`;
          }
          setTick((t) => t + 1);
          const summary = `Loaded file ${file.name} into Node ${node.nodeId} (${node.name}): ${res.written.length} written, ${res.skipped.length} unique/identity skipped${storeText}`;
          setLastOutcome(summary);
          bus.emitStatus(summary);
        } else {
          setTick((t) => t + 1);
          setLastOutcome(
            `Imported profile ${file.name} (${Object.keys(parsed.registers).length} portable registers)`
          );
        }
      } catch (err) {
        setLastOutcome(`Import error: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    reader.readAsText(file);
  };

  const handleLoadIntoNode = (dryRun: boolean) => {
    if (!node || !selectedProfile) return;
    const options = { includePorts, includeIdentity };

    if (dryRun) {
      const planned = differences.filter(
        (d) => d.kind === 'changed' && !isSkippedOnLoad(d.name, options)
      );
      setLastOutcome(
        planned.length === 0
          ? 'Dry-run: nothing to write (all portable registers match).'
          : `Dry-run would write ${planned.length} portable register(s): ${planned
              .map((d) => `${d.name}=${d.profile?.format()}`)
              .join(', ')}`
      );
      return;
    }

    const res = loadProfileSync(
      selectedProfile,
      registers,
      (name, val) => bus.writeRegister(node.nodeId, name, val),
      options
    );

    let storeText = '';
    if (storeAfterLoad && res.complete) {
      const status = bus.executeCommand(node.nodeId, COMMANDS.store);
      storeText = status === 0 ? ' · stored in flash' : ` · store refused (status ${status})`;
    }

    setTick((t) => t + 1);
    const summary = `Written: ${res.written.length}, Preserved unique/ports: ${res.skipped.length}, Rejected: ${Object.keys(res.rejected).length}${storeText}`;
    setLastOutcome(summary);
    bus.emitStatus(`node ${node.nodeId}: profile ${selectedProfileName} loaded (${summary})`);
  };

  const handleTransferToSimilarNodes = () => {
    if (!node) return;
    const validTargets = similarNodes
      .map((s) => s.summary.nodeId)
      .filter((id) => transferTargetIds.has(id));
    if (validTargets.length === 0) return;

    const sourceProfile = createProfileFromRegisters(registers, {
      nodeName: node.name,
      softwareVersion: node.softwareVersion,
      vcsRevision: node.vcsRevision,
      includePorts: false,
      includeIdentity: false,
    });

    const reports: string[] = [];
    for (const targetId of validTargets) {
      const targetRegs = bus.scanRegisters(targetId);
      const res = loadProfileSync(
        sourceProfile,
        targetRegs,
        (name, val) => bus.writeRegister(targetId, name, val),
        { includePorts: false, includeIdentity: false }
      );
      let storeNote = '';
      if (storeAfterLoad && res.complete) {
        const st = bus.executeCommand(targetId, COMMANDS.store);
        storeNote = st === 0 ? ', stored' : ', store refused';
      }
      reports.push(`Node ${targetId} (${res.written.length} written${storeNote})`);
    }

    setTick((t) => t + 1);
    const msg = `Transferred settings from Node ${node.nodeId} (${node.name}) -> ${reports.join('; ')} [excluded node.id, node.description, unique_id & port IDs]`;
    setLastOutcome(msg);
    bus.emitStatus(msg);
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto bg-white p-3 sm:p-4 text-xs">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* 1. Save Node Registers to File */}
        <div className="flex flex-col justify-between rounded border border-slate-200 bg-slate-50/70 p-3.5">
          <div>
            <h3 className="font-semibold text-slate-900">
              1. Save Node Registers to File (`profile save`)
            </h3>
            <p className="mt-1 text-[11px] text-slate-500">
              Exports persistent mutable settings of{' '}
              <strong>{node ? `Node ${node.nodeId} (${node.name})` : 'selected node'}</strong> while
              automatically excluding <code>uavcan.node.id</code>,{' '}
              <code>uavcan.node.description</code>, <code>unique_id</code>, and port IDs.
            </p>
            <div className="mt-2.5 flex items-center gap-2">
              <input
                type="text"
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                placeholder="fl_drive.json"
                className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs"
              />
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!node}
              onClick={() => handleSaveFromNode(true)}
              className="rounded bg-slate-900 px-3 py-1.5 font-semibold text-white hover:bg-slate-800 disabled:opacity-40"
            >
              Save to File (.json)
            </button>
            <button
              type="button"
              disabled={!node}
              onClick={() => handleSaveFromNode(false)}
              className="rounded border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
            >
              Save to Session
            </button>
          </div>
        </div>

        {/* 2. Load from File & Compare */}
        <div className="flex flex-col justify-between rounded border border-slate-200 bg-slate-50/70 p-3.5">
          <div>
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold text-slate-900">
                2. Load from File / Diff (`profile load`)
              </h3>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleDownloadJson}
                  className="font-mono text-[11px] font-medium text-blue-700 hover:underline"
                >
                  Download
                </button>
                <label className="cursor-pointer font-mono text-[11px] font-medium text-blue-700 hover:underline">
                  Load File...
                  <input
                    type="file"
                    accept=".json"
                    onChange={(e) => handleUploadJson(e, true)}
                    className="hidden"
                  />
                </label>
              </div>
            </div>

            <div className="mt-2.5 flex items-center gap-2">
              <select
                value={selectedProfileName}
                onChange={(e) => setSelectedProfileName(e.target.value)}
                className="min-w-0 flex-1 rounded border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs"
              >
                {profileNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-2.5 flex flex-wrap items-center gap-3 text-[11px] text-slate-600">
              <label
                className="flex items-center gap-1.5"
                title="By default, subject/service port IDs are excluded so each node keeps its own bus channels"
              >
                <input
                  type="checkbox"
                  checked={includePorts}
                  onChange={(e) => setIncludePorts(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <code>--include-ports</code>
              </label>
              <label
                className="flex items-center gap-1.5"
                title="By default, uavcan.node.id and uavcan.node.description are excluded"
              >
                <input
                  type="checkbox"
                  checked={includeIdentity}
                  onChange={(e) => setIncludeIdentity(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <code>--include-identity</code>
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={storeAfterLoad}
                  onChange={(e) => setStoreAfterLoad(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <code>--store</code>
              </label>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!node || !selectedProfile}
              onClick={() => handleLoadIntoNode(true)}
              className="rounded border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-40"
            >
              Dry Run
            </button>

            <button
              type="button"
              disabled={!node || !selectedProfile}
              onClick={() => handleLoadIntoNode(false)}
              className="rounded bg-blue-600 px-3.5 py-1.5 font-semibold text-white hover:bg-blue-700 disabled:opacity-40"
            >
              Load into Node {node?.nodeId ?? ''}
            </button>
          </div>
        </div>

        {/* 3. Direct Node-to-Node Register Transfer */}
        <div className="flex flex-col justify-between rounded border border-slate-200 bg-slate-50/70 p-3.5">
          <div>
            <div className="flex items-center justify-between gap-2">
              <h3 className="font-semibold text-slate-900">
                3. Transfer Settings to Similar Node(s)
              </h3>
              {similarNodes.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setTransferTargetIds(new Set(similarNodes.map((s) => s.summary.nodeId)))
                  }
                  className="font-mono text-[11px] font-medium text-blue-700 hover:underline"
                >
                  Select All
                </button>
              )}
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              Directly clones portable motor &amp; controller registers from{' '}
              <strong>{node ? `Node ${node.nodeId} (${node.name})` : 'source'}</strong> to compatible
              nodes without overwriting target node IDs or descriptions.
            </p>

            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {similarNodes.length === 0 ? (
                <span className="text-[11px] text-slate-400">
                  No other compatible nodes found on bus.
                </span>
              ) : (
                similarNodes.map(({ summary, shared, total }) => {
                  const active = transferTargetIds.has(summary.nodeId);
                  return (
                    <button
                      key={summary.nodeId}
                      type="button"
                      onClick={() => {
                        setTransferTargetIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(summary.nodeId)) next.delete(summary.nodeId);
                          else next.add(summary.nodeId);
                          return next;
                        });
                      }}
                      title={`${shared}/${total} shared portable registers`}
                      className={`rounded border px-2 py-1 font-mono text-[11px] transition-colors ${
                        active
                          ? 'border-blue-600 bg-blue-600 font-semibold text-white'
                          : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      #{summary.nodeId} {summary.name} ({shared}/{total})
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] text-slate-500">
              Excludes {excludedOnNode.length} unique/ID regs
            </span>
            <button
              type="button"
              disabled={
                !node ||
                similarNodes.filter((s) => transferTargetIds.has(s.summary.nodeId)).length === 0
              }
              onClick={handleTransferToSimilarNodes}
              className="rounded bg-emerald-600 px-3.5 py-1.5 font-semibold text-white hover:bg-emerald-700 disabled:opacity-40"
            >
              Transfer from #{node?.nodeId ?? '?'} &rarr; Selected
            </button>
          </div>
        </div>
      </div>

      {lastOutcome && (
        <div className="rounded border border-blue-200 bg-blue-50/70 px-3 py-2 font-mono text-xs text-blue-900">
          {lastOutcome}
        </div>
      )}

      {/* Excluded Unique / Identity Registers Strip */}
      {node && excludedOnNode.length > 0 && (
        <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="font-semibold text-slate-700">
              Protected Unique / Identity Registers on Node {node.nodeId} (excluded by default):
            </span>
            {excludedOnNode.map((r) => (
              <span
                key={r.name}
                className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-600"
              >
                {r.name}={r.value.format()}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Profile Diff Table */}
      <div className="flex-1 overflow-auto rounded border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
          <span className="font-semibold text-slate-800">
            Portable Register Diff: <code>{selectedProfileName}</code> vs{' '}
            {node ? `Node ${node.nodeId} (${node.name})` : 'selected node'} ({differences.length})
          </span>
          {selectedProfile && (
            <span className="font-mono text-[11px] text-slate-500">
              source={selectedProfile.nodeName || '?'} · format={1} · portable_registers=
              {Object.keys(selectedProfile.registers).length}
            </span>
          )}
        </div>

        {!node ? (
          <div className="p-8 text-center text-slate-400">Select a node to compare settings.</div>
        ) : differences.length === 0 ? (
          <div className="p-8 text-center font-mono text-emerald-700">
            no differences — all portable mutable persistent registers match
          </div>
        ) : (
          <table className="w-full min-w-[480px] border-collapse text-left font-mono text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-100 text-[11px] font-semibold text-slate-600">
                <th className="px-3 py-2">NAME</th>
                <th className="px-3 py-2">PROFILE</th>
                <th className="px-3 py-2">NODE #{node.nodeId}</th>
                <th className="px-3 py-2">STATUS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {differences.map((d) => (
                <tr key={d.name} className="hover:bg-slate-50">
                  <td className="px-3 py-1.5 text-slate-900">{d.name}</td>
                  <td className="px-3 py-1.5 tabular-nums text-blue-700">
                    {d.profile ? d.profile.format() : '-'}
                  </td>
                  <td className="px-3 py-1.5 tabular-nums text-slate-700">
                    {d.node ? d.node.format() : '-'}
                  </td>
                  <td className="px-3 py-1.5 text-slate-500">
                    {d.kind !== 'changed' ? d.kind : 'changed'}
                    {d.skippedOnLoad
                      ? ` · skipped (${d.skipReason ?? 'unique to node'})`
                      : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
