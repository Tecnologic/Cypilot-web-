// SPDX-License-Identifier: Apache-2.0
import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, GitCompare } from 'lucide-react';
import { COMMANDS, CypilotBusEngine, NodeSummary } from '../core/busEngine';
import {
  classifyUniqueRegister,
  createProfileFromRegisters,
  diffProfile,
  loadProfileSync,
  profileFromJson,
  profileToJson,
} from '../core/profiles';
import {
  Register,
  formatRegisterFlags,
  formatRegisterType,
  parseLike,
} from '../core/registers';

interface RegisterPanelProps {
  bus: CypilotBusEngine;
  node: NodeSummary | null;
}

interface TreeBranch {
  label: string;
  prefix: string;
  children: Map<string, TreeBranch>;
  leaves: Register[];
}

function buildTree(registers: Register[]): TreeBranch {
  const root: TreeBranch = { label: '', prefix: '', children: new Map(), leaves: [] };
  for (const reg of registers) {
    const parts = reg.name.split('.');
    let cur = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const prefix = parts.slice(0, i + 1).join('.');
      let next = cur.children.get(part);
      if (!next) {
        next = { label: part, prefix, children: new Map(), leaves: [] };
        cur.children.set(part, next);
      }
      cur = next;
    }
    cur.leaves.push(reg);
  }
  return root;
}

export const RegisterPanel: React.FC<RegisterPanelProps> = ({ bus, node }) => {
  const [filterText, setFilterText] = useState('');
  const [onlyMutable, setOnlyMutable] = useState(false);
  const [hideUnique, setHideUnique] = useState(false);
  const [collapsedPrefixes, setCollapsedPrefixes] = useState<Set<string>>(new Set());
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<string>('');
  const [rejectedMap, setRejectedMap] = useState<Record<string, boolean>>({});
  const [scanTick, setScanTick] = useState(0);
  const [bannerMessage, setBannerMessage] = useState<string>('');

  // Side-by-Side Node Compare state
  const [compareMode, setCompareMode] = useState(false);
  const [compareNodeAId, setCompareNodeAId] = useState<number>(node?.nodeId ?? 10);
  const [compareNodeBId, setCompareNodeBId] = useState<number>(12);
  const [compareOnlyDiffs, setCompareOnlyDiffs] = useState(false);

  // Transfer to similar node modal state
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [targetNodeIds, setTargetNodeIds] = useState<Set<number>>(new Set());
  const [storeAfterTransfer, setStoreAfterTransfer] = useState(true);

  const allNodes = bus.nodes();

  const registers = useMemo(() => {
    if (!node || !bus.isConnected) return [];
    try {
      return bus.scanRegisters(node.nodeId);
    } catch {
      return [];
    }
  }, [bus, node, node?.vendorCode, scanTick]);

  // Discover similar nodes on the bus (same node family / shared portable register schema)
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
        const otherPortable = otherRegs.filter(
          (r) => r.mutable && r.persistent && !classifyUniqueRegister(r.name).isUnique
        );
        const sharedCount = otherPortable.filter((r) => sourcePortableNames.has(r.name)).length;
        return {
          summary: other,
          sharedCount,
          totalPortable: sourcePortableNames.size,
        };
      })
      .filter((item) => item.sharedCount > 0);
  }, [allNodes, bus, node, registers]);

  const filteredRegisters = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    return registers.filter((r) => {
      if (onlyMutable && !r.mutable) return false;
      if (hideUnique && classifyUniqueRegister(r.name).isUnique) return false;
      if (query && !r.name.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [registers, filterText, onlyMutable, hideUnique]);

  // Compute side-by-side comparison rows between Node A and Node B
  const compareRows = useMemo(() => {
    if (!compareMode || !bus.isConnected) return [];
    const regsA = bus.scanRegisters(compareNodeAId);
    const regsB = bus.scanRegisters(compareNodeBId);
    const mapA = new Map<string, Register>(regsA.map((r) => [r.name, r]));
    const mapB = new Map<string, Register>(regsB.map((r) => [r.name, r]));

    const allNames = Array.from(new Set([...mapA.keys(), ...mapB.keys()])).sort();
    const query = filterText.trim().toLowerCase();

    return allNames
      .map((name) => {
        const regA = mapA.get(name) ?? null;
        const regB = mapB.get(name) ?? null;
        const refReg = regA ?? regB!;
        const isSame =
          regA !== null && regB !== null && regA.value.sameAs(regB.value);
        const isDiff = !isSame;
        const uniqueMeta = classifyUniqueRegister(name);

        return {
          name,
          regA,
          regB,
          refReg,
          isDiff,
          uniqueMeta,
        };
      })
      .filter((row) => {
        if (onlyMutable && !row.refReg.mutable) return false;
        if (hideUnique && row.uniqueMeta.isUnique) return false;
        if (compareOnlyDiffs && !row.isDiff) return false;
        if (query && !row.name.toLowerCase().includes(query)) return false;
        return true;
      });
  }, [
    bus,
    compareMode,
    compareNodeAId,
    compareNodeBId,
    onlyMutable,
    hideUnique,
    compareOnlyDiffs,
    filterText,
    scanTick,
  ]);

  const totalCompareDiffCount = useMemo(() => {
    return compareRows.filter((r) => r.isDiff).length;
  }, [compareRows]);

  const tree = useMemo(() => buildTree(filteredRegisters), [filteredRegisters]);

  const handleToggleCompare = () => {
    if (!compareMode) {
      const aId = node?.nodeId ?? allNodes[0]?.nodeId ?? 10;
      const bCandidate =
        allNodes.find((n) => n.nodeId !== aId && n.nodeId === 12)?.nodeId ??
        allNodes.find((n) => n.nodeId !== aId)?.nodeId ??
        aId;
      setCompareNodeAId(aId);
      setCompareNodeBId(bCandidate);
      setCompareMode(true);
    } else {
      setCompareMode(false);
    }
  };

  const handleCopySingleRegister = (
    fromNodeId: number,
    toNodeId: number,
    reg: Register
  ) => {
    const outcome = bus.writeRegister(toNodeId, reg.name, reg.value);
    setScanTick((t) => t + 1);
    if (outcome.accepted) {
      const msg = `Copied ${reg.name} = ${reg.value.format()} from Node ${fromNodeId} -> Node ${toNodeId}`;
      setBannerMessage(msg);
      bus.emitStatus(msg);
    } else {
      const msg = `Node ${toNodeId} rejected ${reg.name} = ${reg.value.format()} (kept ${outcome.register.value.format()})`;
      setBannerMessage(msg);
      bus.emitStatus(msg);
    }
  };

  const handleRefresh = () => {
    if (!node) return;
    setScanTick((t) => t + 1);
    const count = bus.scanRegisters(node.nodeId).length;
    bus.emitStatus(`${count} registers of node ${node.nodeId}`, false);
  };

  const handleStore = () => {
    if (!node) return;
    const status = bus.executeCommand(node.nodeId, COMMANDS.store);
    if (status === 0) {
      bus.emitStatus(`node ${node.nodeId}: settings stored`);
    } else if (status === 5) {
      bus.emitStatus(`node ${node.nodeId}: store refused while the power stage is enabled`);
    } else {
      bus.emitStatus(`node ${node.nodeId}: store answered status ${status}`);
    }
  };

  // Save node registers to JSON file (excluding node ID, description, unique ID, and port IDs)
  const handleSaveToFile = () => {
    if (!node) return;
    const profile = createProfileFromRegisters(registers, {
      nodeName: node.name,
      softwareVersion: node.softwareVersion,
      vcsRevision: node.vcsRevision,
      includeIdentity: false,
      includePorts: false,
    });
    const safeRole = (node.name || `node_${node.nodeId}`)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '');
    const fileName = `${safeRole}_settings.json`;
    bus.savedProfiles.set(fileName, profile);

    const jsonText = profileToJson(profile);
    const blob = new Blob([jsonText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);

    const savedCount = Object.keys(profile.registers).length;
    const excludedCount = profile.excludedUnique?.length ?? 0;
    const msg = `Saved ${savedCount} portable registers to ${fileName} (excluded ${excludedCount} unique/identity/port registers: uavcan.node.id, uavcan.node.description, port IDs)`;
    setBannerMessage(msg);
    bus.emitStatus(`node ${node.nodeId}: ${msg}`);
  };

  // Load registers from JSON file into current node (skipping node ID, description, unique ID, and port IDs)
  const handleLoadFromFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !node) return;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = profileFromJson(String(reader.result));
        bus.savedProfiles.set(file.name, parsed);
        const res = loadProfileSync(
          parsed,
          registers,
          (name, val) => bus.writeRegister(node.nodeId, name, val),
          { includeIdentity: false, includePorts: false }
        );
        setScanTick((t) => t + 1);
        const msg = `Loaded ${file.name} into Node ${node.nodeId} (${node.name}): ${res.written.length} written, ${res.skipped.length} unique/port registers preserved, ${Object.keys(res.rejected).length} rejected`;
        setBannerMessage(msg);
        bus.emitStatus(msg);
      } catch (err) {
        const errMsg = `Failed to load ${file.name}: ${err instanceof Error ? err.message : String(err)}`;
        setBannerMessage(errMsg);
        bus.emitStatus(errMsg);
      }
    };
    reader.readAsText(file);
  };

  // Open transfer modal and pre-select first similar node
  const handleOpenTransferModal = () => {
    if (similarNodes.length > 0 && targetNodeIds.size === 0) {
      setTargetNodeIds(new Set([similarNodes[0].summary.nodeId]));
    }
    setTransferModalOpen(true);
  };

  const handleExecuteTransfer = () => {
    if (!node || targetNodeIds.size === 0) return;
    const sourceProfile = createProfileFromRegisters(registers, {
      nodeName: node.name,
      softwareVersion: node.softwareVersion,
      vcsRevision: node.vcsRevision,
      includeIdentity: false,
      includePorts: false,
    });

    const summaries: string[] = [];
    for (const targetId of Array.from(targetNodeIds).sort((a, b) => a - b)) {
      const targetRegs = bus.scanRegisters(targetId);
      const res = loadProfileSync(
        sourceProfile,
        targetRegs,
        (name, val) => bus.writeRegister(targetId, name, val),
        { includeIdentity: false, includePorts: false }
      );
      let storedNote = '';
      if (storeAfterTransfer && res.complete) {
        const st = bus.executeCommand(targetId, COMMANDS.store);
        storedNote = st === 0 ? ', stored' : ', store refused';
      }
      summaries.push(`#${targetId} (${res.written.length} written${storedNote})`);
    }

    setTransferModalOpen(false);
    setScanTick((t) => t + 1);
    const msg = `Transferred portable settings from Node ${node.nodeId} (${node.name}) -> ${summaries.join('; ')} [preserved target node.id, node.description & port IDs]`;
    setBannerMessage(msg);
    bus.emitStatus(msg);
  };

  const handleStartEdit = (reg: Register) => {
    if (!reg.mutable) return;
    setEditingName(reg.name);
    setEditDraft(reg.value.format());
  };

  const handleCommitEdit = (reg: Register) => {
    if (!node || editingName !== reg.name) return;
    setEditingName(null);
    const trimmed = editDraft.trim();
    if (trimmed === reg.value.format() && !rejectedMap[reg.name]) {
      return;
    }
    try {
      const parsed = parseLike(trimmed, reg.value);
      const outcome = bus.writeRegister(node.nodeId, reg.name, parsed);
      if (outcome.accepted) {
        setRejectedMap((prev) => ({ ...prev, [reg.name]: false }));
        bus.emitStatus(`${reg.name} = ${outcome.register.value.format()}`);
      } else {
        setRejectedMap((prev) => ({ ...prev, [reg.name]: true }));
        bus.emitStatus(
          `${reg.name}: rejected, the node keeps ${outcome.register.value.format()}`
        );
      }
      setScanTick((t) => t + 1);
    } catch (err) {
      bus.emitStatus(`${reg.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const togglePrefix = (prefix: string) => {
    setCollapsedPrefixes((prev) => {
      const next = new Set(prev);
      if (next.has(prefix)) {
        next.delete(prefix);
      } else {
        next.add(prefix);
      }
      return next;
    });
  };

  const renderBranch = (branch: TreeBranch, depth: number): React.ReactNode[] => {
    const rows: React.ReactNode[] = [];
    for (const child of branch.children.values()) {
      const isCollapsed = collapsedPrefixes.has(child.prefix) && !filterText.trim();
      rows.push(
        <tr
          key={`branch:${child.prefix}`}
          onClick={() => togglePrefix(child.prefix)}
          className="cursor-pointer border-b border-slate-100 bg-slate-50/70 hover:bg-slate-100/80"
        >
          <td
            colSpan={4}
            className="py-1.5 pr-3 font-mono text-xs font-semibold text-slate-700"
            style={{ paddingLeft: `${depth * 16 + 12}px` }}
          >
            <span className="inline-flex items-center gap-1">
              {isCollapsed ? (
                <ChevronRight className="h-3.5 w-3.5 text-slate-500" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
              )}
              {child.label}
            </span>
          </td>
        </tr>
      );
      if (!isCollapsed) {
        rows.push(...renderBranch(child, depth + 1));
      }
    }

    for (const reg of branch.leaves) {
      const shortName = reg.name.split('.').pop() || reg.name;
      const isEditing = editingName === reg.name;
      const isRejected = Boolean(rejectedMap[reg.name]);
      const uniqueMeta = classifyUniqueRegister(reg.name);

      rows.push(
        <tr
          key={`leaf:${reg.name}`}
          className="border-b border-slate-100 text-xs hover:bg-blue-50/40"
        >
          <td
            className="py-1.5 pr-3 font-mono text-slate-900"
            style={{ paddingLeft: `${depth * 16 + 24}px` }}
            title={
              uniqueMeta.isUnique
                ? `${reg.name} — ${uniqueMeta.reason} (excluded from file save/transfer)`
                : reg.description
                  ? `${reg.name} — ${reg.description}`
                  : reg.name
            }
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span>{shortName}</span>
              {uniqueMeta.isUnique && (
                <span
                  className="rounded border border-amber-300 bg-amber-50 px-1 py-0 text-[10px] text-amber-800"
                  title={uniqueMeta.reason ?? 'Node-unique register'}
                >
                  unique:{uniqueMeta.category}
                </span>
              )}
            </div>
            {reg.description && (
              <span className="ml-2 font-sans text-[11px] text-slate-400 hidden xl:inline">
                {reg.description}
              </span>
            )}
          </td>

          <td
            onClick={() => !isEditing && handleStartEdit(reg)}
            className={`px-3 py-1.5 font-mono tabular-nums ${
              reg.mutable ? 'cursor-text hover:bg-blue-50/60' : 'text-slate-500'
            }`}
            style={isRejected ? { color: '#c62828', fontWeight: 600 } : undefined}
          >
            {isEditing ? (
              <input
                type="text"
                autoFocus
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onBlur={() => handleCommitEdit(reg)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCommitEdit(reg);
                  if (e.key === 'Escape') setEditingName(null);
                }}
                className="w-full rounded border border-blue-600 bg-white px-1.5 py-0.5 font-mono text-xs text-slate-900 focus:outline-none"
              />
            ) : (
              <span>
                {reg.value.format()}
                {reg.unit ? <span className="ml-1 text-slate-400">{reg.unit}</span> : null}
              </span>
            )}
          </td>

          <td className="px-3 py-1.5 font-mono text-slate-500">{formatRegisterType(reg)}</td>

          <td className="px-3 py-1.5 font-mono text-slate-500">
            {formatRegisterFlags(reg)}
            {reg.min !== undefined && reg.max !== undefined && (
              <span className="ml-2 text-[11px] text-slate-400">
                [{reg.min}..{reg.max}]
              </span>
            )}
          </td>
        </tr>
      );
    }

    return rows;
  };

  // Preview portable diff vs first selected target node in Transfer modal
  const previewTargetId = Array.from(targetNodeIds)[0] ?? null;
  const transferPreviewDiffs = useMemo(() => {
    if (!node || previewTargetId === null) return [];
    const srcProfile = createProfileFromRegisters(registers, {
      nodeName: node.name,
      includeIdentity: false,
      includePorts: false,
    });
    const targetRegs = bus.scanRegisters(previewTargetId);
    return diffProfile(srcProfile, targetRegs, { includeIdentity: false, includePorts: false });
  }, [bus, node, registers, previewTargetId]);

  const excludedUniqueList = useMemo(() => {
    return registers.filter((r) => classifyUniqueRegister(r.name).isUnique);
  }, [registers]);

  const nodeASummary = allNodes.find((n) => n.nodeId === compareNodeAId) ?? null;
  const nodeBSummary = allNodes.find((n) => n.nodeId === compareNodeBId) ?? null;

  return (
    <div className="flex h-full flex-col bg-white">
      {/* Top Register Action Bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2">
        <div className="min-w-[130px] text-xs font-semibold text-slate-800">
          {node ? `Node ${node.nodeId}: ${node.name || '?'}` : 'No node selected'}
        </div>

        <input
          type="text"
          disabled={!node && !compareMode}
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="Filter, e.g. motor.limits"
          className="min-w-[140px] flex-1 rounded border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-900 focus:border-blue-600 focus:outline-none disabled:bg-slate-100"
        />

        <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600 whitespace-nowrap">
          <input
            type="checkbox"
            disabled={!node && !compareMode}
            checked={onlyMutable}
            onChange={(e) => setOnlyMutable(e.target.checked)}
            className="rounded border-slate-300"
          />
          Mutable only
        </label>

        <label
          className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600 whitespace-nowrap"
          title="Hide node-unique registers (uavcan.node.id, uavcan.node.description, unique_id, port IDs)"
        >
          <input
            type="checkbox"
            disabled={!node && !compareMode}
            checked={hideUnique}
            onChange={(e) => setHideUnique(e.target.checked)}
            className="rounded border-slate-300"
          />
          Hide unique/IDs
        </label>

        {/* Side-by-Side Compare Two Nodes Toggle Button */}
        <button
          type="button"
          disabled={allNodes.length < 2}
          onClick={handleToggleCompare}
          title="Compare registers of two different nodes side-by-side, highlighting differences in red"
          className={`inline-flex items-center gap-1.5 rounded border px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
            compareMode
              ? 'border-red-600 bg-[#c62828] text-white'
              : 'border-slate-300 bg-white text-slate-800 hover:bg-slate-100'
          } disabled:opacity-40`}
        >
          <GitCompare className="h-3.5 w-3.5" />
          <span>{compareMode ? 'Exit Compare' : 'Compare Nodes'}</span>
        </button>

        <button
          type="button"
          disabled={!node}
          onClick={handleSaveToFile}
          title="Save portable registers of this node to a JSON file (automatically excludes uavcan.node.id, uavcan.node.description, unique_id, and port IDs)"
          className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-50 whitespace-nowrap"
        >
          Save to File
        </button>

        <label
          className={`cursor-pointer rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100 whitespace-nowrap ${
            !node ? 'pointer-events-none opacity-50' : ''
          }`}
          title="Load register settings from a JSON file into this node (preserves node ID, description, and port IDs)"
        >
          Load from File
          <input
            type="file"
            accept=".json"
            disabled={!node}
            onChange={handleLoadFromFile}
            className="hidden"
          />
        </label>

        <button
          type="button"
          disabled={!node || similarNodes.length === 0}
          onClick={handleOpenTransferModal}
          title="Copy portable tuning registers from this node to one or more similar nodes on the bus (excluding node ID, description, and port IDs)"
          className="rounded bg-blue-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-40 whitespace-nowrap"
        >
          Transfer ({similarNodes.length})
        </button>

        <button
          type="button"
          disabled={!node}
          onClick={handleRefresh}
          className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-50"
        >
          Refresh
        </button>

        <button
          type="button"
          disabled={!node}
          onClick={handleStore}
          title="ExecuteCommand STORE_PERSISTENT_STATES: save the settings in flash"
          className="rounded bg-slate-900 px-3 py-1 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          Store
        </button>
      </div>

      {/* Compare Bar when Compare Mode is active */}
      {compareMode && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-100 px-3 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-800">Side-by-Side Node Compare:</span>

            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[11px] text-slate-600">Node A:</span>
              <select
                value={compareNodeAId}
                onChange={(e) => setCompareNodeAId(Number(e.target.value))}
                className="rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs text-slate-900"
              >
                {allNodes.map((n) => (
                  <option key={n.nodeId} value={n.nodeId}>
                    Node {n.nodeId} ({n.name || '?'})
                  </option>
                ))}
              </select>
            </div>

            <span className="font-mono font-bold text-slate-500">vs</span>

            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[11px] text-slate-600">Node B:</span>
              <select
                value={compareNodeBId}
                onChange={(e) => setCompareNodeBId(Number(e.target.value))}
                className="rounded border border-slate-300 bg-white px-2 py-1 font-mono text-xs text-slate-900"
              >
                {allNodes.map((n) => (
                  <option key={n.nodeId} value={n.nodeId}>
                    Node {n.nodeId} ({n.name || '?'})
                  </option>
                ))}
              </select>
            </div>

            <label className="ml-2 flex cursor-pointer items-center gap-1.5 font-medium text-slate-700">
              <input
                type="checkbox"
                checked={compareOnlyDiffs}
                onChange={(e) => setCompareOnlyDiffs(e.target.checked)}
                className="rounded border-slate-300 text-red-600"
              />
              <span>Show only differences ({totalCompareDiffCount})</span>
            </label>
          </div>

          <div className="flex items-center gap-2 font-mono text-[11px]">
            <span className="rounded border border-red-300 bg-red-50 px-2 py-0.5 font-semibold text-[#c62828]">
              {totalCompareDiffCount} difference{totalCompareDiffCount !== 1 ? 's' : ''} highlighted
              in red
            </span>
          </div>
        </div>
      )}

      {bannerMessage && (
        <div className="flex items-center justify-between border-b border-blue-200 bg-blue-50 px-3 py-1.5 font-mono text-[11px] text-blue-900">
          <span className="truncate">{bannerMessage}</span>
          <button
            type="button"
            onClick={() => setBannerMessage('')}
            className="ml-3 text-xs font-semibold text-blue-700 hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {compareMode ? (
          <table className="w-full min-w-[680px] border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-100 text-[11px] font-semibold text-slate-600">
              <tr>
                <th className="w-[34%] px-3 py-2">Register</th>
                <th className="w-[22%] px-3 py-2 font-mono">
                  Node A: #{compareNodeAId} ({nodeASummary?.name || '?'})
                </th>
                <th className="w-[22%] px-3 py-2 font-mono">
                  Node B: #{compareNodeBId} ({nodeBSummary?.name || '?'})
                </th>
                <th className="w-[10%] px-2 py-2">Type</th>
                <th className="w-[12%] px-3 py-2 text-right">Sync / Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono">
              {compareRows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center font-sans text-xs text-slate-400">
                    No registers match the current comparison filter.
                  </td>
                </tr>
              ) : (
                compareRows.map(({ name, regA, regB, refReg, isDiff, uniqueMeta }) => {
                  return (
                    <tr
                      key={name}
                      className={
                        isDiff
                          ? 'bg-red-50/80 text-[#c62828] font-semibold'
                          : 'hover:bg-slate-50 text-slate-800'
                      }
                    >
                      <td className="px-3 py-1.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className={isDiff ? 'text-[#c62828] font-bold' : 'text-slate-900'}>
                            {name}
                          </span>
                          {uniqueMeta.isUnique && (
                            <span className="rounded border border-amber-300 bg-amber-50 px-1 py-0 text-[10px] font-normal text-amber-800">
                              unique:{uniqueMeta.category}
                            </span>
                          )}
                        </div>
                      </td>

                      <td
                        className={`px-3 py-1.5 tabular-nums ${
                          isDiff ? 'text-[#c62828] font-bold' : 'text-slate-700'
                        }`}
                      >
                        {regA ? regA.value.format() : <span className="italic opacity-60">missing</span>}
                        {refReg.unit ? (
                          <span className="ml-1 text-[10px] opacity-75">{refReg.unit}</span>
                        ) : null}
                      </td>

                      <td
                        className={`px-3 py-1.5 tabular-nums ${
                          isDiff ? 'text-[#c62828] font-bold' : 'text-slate-700'
                        }`}
                      >
                        {regB ? regB.value.format() : <span className="italic opacity-60">missing</span>}
                        {refReg.unit ? (
                          <span className="ml-1 text-[10px] opacity-75">{refReg.unit}</span>
                        ) : null}
                      </td>

                      <td className="px-2 py-1.5 text-[11px] font-normal text-slate-500">
                        {formatRegisterType(refReg)}
                      </td>

                      <td className="px-3 py-1.5 text-right whitespace-nowrap">
                        {isDiff ? (
                          <div className="inline-flex items-center gap-1">
                            <span className="rounded bg-[#c62828] px-1.5 py-0.5 text-[10px] font-bold text-white">
                              DIFF
                            </span>
                            {regA && regB && regB.mutable && !uniqueMeta.isUnique && (
                              <button
                                type="button"
                                onClick={() =>
                                  handleCopySingleRegister(compareNodeAId, compareNodeBId, regA)
                                }
                                title={`Write Node ${compareNodeAId}'s value (${regA.value.format()}) to Node ${compareNodeBId}`}
                                className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-800 hover:bg-slate-100"
                              >
                                A&rarr;B
                              </button>
                            )}
                            {regA && regB && regA.mutable && !uniqueMeta.isUnique && (
                              <button
                                type="button"
                                onClick={() =>
                                  handleCopySingleRegister(compareNodeBId, compareNodeAId, regB)
                                }
                                title={`Write Node ${compareNodeBId}'s value (${regB.value.format()}) to Node ${compareNodeAId}`}
                                className="rounded border border-slate-300 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-800 hover:bg-slate-100"
                              >
                                B&rarr;A
                              </button>
                            )}
                          </div>
                        ) : (
                          <span className="text-[11px] font-normal text-emerald-600">match</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        ) : !node ? (
          <div className="p-8 text-center text-xs text-slate-400">
            Select a node to scan, edit, compare, save, or transfer its Cyphal registers.
          </div>
        ) : (
          <table className="w-full min-w-[540px] border-collapse text-left">
            <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-100 text-[11px] font-semibold text-slate-600">
              <tr>
                <th className="w-[46%] px-3 py-2">Register</th>
                <th className="w-[24%] px-3 py-2">Value (click to edit)</th>
                <th className="w-[14%] px-3 py-2">Type</th>
                <th className="w-[16%] px-3 py-2">Flags &amp; Bounds</th>
              </tr>
            </thead>
            <tbody>{renderBranch(tree, 0)}</tbody>
          </table>
        )}
      </div>

      {/* Transfer Register Settings to Similar Node Modal */}
      {transferModalOpen && node && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-3 sm:p-4">
          <div className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded border border-slate-300 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  Transfer Register Settings from Node {node.nodeId} ({node.name})
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  Copies portable persistent tuning registers to similar nodes while preserving each
                  target node&apos;s own <code>uavcan.node.id</code>,{' '}
                  <code>uavcan.node.description</code>, <code>unique_id</code>, and port IDs.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setTransferModalOpen(false)}
                className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100"
              >
                Close
              </button>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto p-4 text-xs">
              {/* Target Similar Nodes Selector */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-semibold text-slate-800">
                    1. Select Similar Target Node(s) ({similarNodes.length} compatible on bus)
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setTargetNodeIds(new Set(similarNodes.map((n) => n.summary.nodeId)))
                    }
                    className="font-mono text-[11px] font-medium text-blue-700 hover:underline"
                  >
                    Select All Similar ({similarNodes.length})
                  </button>
                </div>

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {similarNodes.map(({ summary, sharedCount, totalPortable }) => {
                    const checked = targetNodeIds.has(summary.nodeId);
                    return (
                      <label
                        key={summary.nodeId}
                        className={`flex cursor-pointer items-center justify-between rounded border p-2.5 transition-colors ${
                          checked
                            ? 'border-blue-600 bg-blue-50/70'
                            : 'border-slate-200 bg-slate-50/50 hover:bg-slate-100'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setTargetNodeIds((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(summary.nodeId);
                                else next.delete(summary.nodeId);
                                return next;
                              });
                            }}
                            className="rounded border-slate-300 text-blue-600"
                          />
                          <div>
                            <div className="font-mono font-semibold text-slate-900">
                              Node {summary.nodeId}: {summary.name || '?'}
                            </div>
                            <div className="font-mono text-[10px] text-slate-500">
                              State: {summary.chips.join(', ') || '-'} · UID{' '}
                              {summary.uniqueIdHex.slice(0, 12)}
                            </div>
                          </div>
                        </div>
                        <span className="rounded border border-slate-300 bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-700">
                          {sharedCount}/{totalPortable} shared regs
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Excluded Unique Registers Summary */}
              <div className="rounded border border-amber-200 bg-amber-50/60 p-3">
                <div className="font-semibold text-amber-900">
                  2. Excluded Unique &amp; Node-Identity Registers ({excludedUniqueList.length}{' '}
                  untouched)
                </div>
                <p className="mt-0.5 text-[11px] text-amber-800">
                  These registers identify the individual node or its dedicated bus subjects and are
                  never overwritten during file save/load or node-to-node transfer:
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5 font-mono text-[10px]">
                  {excludedUniqueList.map((r) => (
                    <span
                      key={r.name}
                      className="rounded border border-amber-300 bg-white px-1.5 py-0.5 text-slate-700"
                      title={classifyUniqueRegister(r.name).reason ?? ''}
                    >
                      {r.name} = {r.value.format()}
                    </span>
                  ))}
                </div>
              </div>

              {/* Diff Preview against selected target node */}
              {previewTargetId !== null && (
                <div className="rounded border border-slate-200 bg-white">
                  <div className="border-b border-slate-200 bg-slate-50 px-3 py-2 font-semibold text-slate-800">
                    3. Portable Register Changes Preview (Node {node.nodeId} &rarr; Node{' '}
                    {previewTargetId})
                  </div>
                  {transferPreviewDiffs.length === 0 ? (
                    <div className="p-4 text-center font-mono text-emerald-700">
                      All portable registers on Node {previewTargetId} already match Node{' '}
                      {node.nodeId}.
                    </div>
                  ) : (
                    <div className="max-h-48 overflow-y-auto">
                      <table className="w-full text-left font-mono text-[11px]">
                        <thead className="border-b border-slate-200 bg-slate-100 text-slate-600">
                          <tr>
                            <th className="px-3 py-1.5">Register</th>
                            <th className="px-3 py-1.5">Source (#{node.nodeId})</th>
                            <th className="px-3 py-1.5">Target (#{previewTargetId})</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {transferPreviewDiffs.map((d) => (
                            <tr key={d.name}>
                              <td className="px-3 py-1 text-slate-900">{d.name}</td>
                              <td className="px-3 py-1 text-blue-700 font-semibold">
                                {d.profile ? d.profile.format() : '-'}
                              </td>
                              <td className="px-3 py-1 text-slate-600">
                                {d.node ? d.node.format() : '-'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-4 py-3 text-xs">
              <label className="flex cursor-pointer items-center gap-1.5 text-slate-700">
                <input
                  type="checkbox"
                  checked={storeAfterTransfer}
                  onChange={(e) => setStoreAfterTransfer(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span>
                  Execute <code>STORE_PERSISTENT_STATES</code> on target node(s) after transfer
                </span>
              </label>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setTransferModalOpen(false)}
                  className="rounded border border-slate-300 bg-white px-3 py-1.5 font-medium text-slate-700 hover:bg-slate-100"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={targetNodeIds.size === 0}
                  onClick={handleExecuteTransfer}
                  className="rounded bg-blue-600 px-4 py-1.5 font-semibold text-white hover:bg-blue-700 disabled:opacity-40"
                >
                  Transfer to {targetNodeIds.size} Node{targetNodeIds.size !== 1 ? 's' : ''}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
