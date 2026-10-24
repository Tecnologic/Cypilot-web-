// SPDX-License-Identifier: Apache-2.0
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { CliPanel } from './components/CliPanel';
import { CodeReviewPanel } from './components/CodeReviewPanel';
import { ConnectDialog } from './components/ConnectDialog';
import { ControlPanel } from './components/ControlPanel';
import { CymonExpertPanel } from './components/CymonExpertPanel';
import { LogPanel } from './components/LogPanel';
import { NodeTable } from './components/NodeTable';
import { PlotPanel } from './components/PlotPanel';
import { ProfilePanel } from './components/ProfilePanel';
import { RegisterPanel } from './components/RegisterPanel';
import { SimulationPanel } from './components/SimulationPanel';
import { CypilotBusEngine } from './core/busEngine';
import { healthName } from './core/status';
import { DEFAULT_LOCAL_NODE_ID, InterfaceSpec, parseInterface } from './core/transport';

type TabId =
  | 'nodes'
  | 'registers'
  | 'control'
  | 'simulation'
  | 'plot'
  | 'cymon'
  | 'profiles'
  | 'log'
  | 'cli'
  | 'audit';

export const App: React.FC = () => {
  const busRef = useRef<CypilotBusEngine | null>(null);
  if (!busRef.current) {
    busRef.current = new CypilotBusEngine();
  }
  const bus = busRef.current;

  const [, setRenderTick] = useState(0);
  const [watchdogFlash, setWatchdogFlash] = useState(false);
  const [darkMode, setDarkMode] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<number | null>(10);
  const [activeTab, setActiveTab] = useState<TabId>('nodes');
  const [logDockOpen, setLogDockOpen] = useState(true);
  const [connectDialogOpen, setConnectDialogOpen] = useState(false);
  const [estopConfirmOpen, setEstopConfirmOpen] = useState(false);

  // Sync dark theme class on document root
  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
  }, [darkMode]);

  // Subscribe to bus engine updates & start default vcan0 session
  useEffect(() => {
    const unsubscribe = bus.subscribeChange(() => {
      setRenderTick((t) => t + 1);
    });
    // Connect to socketcan:vcan0 on startup so the operator console is immediately active
    bus.connect(parseInterface('socketcan:vcan0'), DEFAULT_LOCAL_NODE_ID);
    return () => {
      unsubscribe();
      bus.disconnect();
    };
  }, [bus]);

  // 100 ms UI thread watchdog feed timer (matching MainWindow.feed_timer in main_window.py)
  useEffect(() => {
    let flashOffTimer: number | null = null;
    const timer = window.setInterval(() => {
      const fed = bus.feedWatchdog();
      if (fed) {
        setWatchdogFlash(true);
        if (flashOffTimer !== null) {
          window.clearTimeout(flashOffTimer);
        }
        flashOffTimer = window.setTimeout(() => {
          setWatchdogFlash(false);
        }, 45);
      } else {
        setWatchdogFlash(false);
        setRenderTick((t) => t + 1);
      }
    }, 100);
    return () => {
      window.clearInterval(timer);
      if (flashOffTimer !== null) {
        window.clearTimeout(flashOffTimer);
      }
    };
  }, [bus]);

  // Global keyboard shortcuts: Esc -> STOP ALL, Shift+Esc -> Emergency Stop
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (connectDialogOpen || estopConfirmOpen) return;
        e.preventDefault();
        if (e.shiftKey) {
          handleAskEmergencyStop();
        } else {
          handleStopAll();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const nodes = bus.nodes();
  const selectedNode = useMemo(
    () => nodes.find((n) => n.nodeId === selectedNodeId) ?? null,
    [nodes, selectedNodeId]
  );

  const selectedCapsAndPorts = useMemo(() => {
    if (!selectedNode) return { capabilities: [], ports: [] };
    return bus.nodeCapabilities(selectedNode.nodeId);
  }, [bus, selectedNode]);

  const handleConnect = (spec: InterfaceSpec, localNodeId: number) => {
    bus.connect(spec, localNodeId);
    const first = bus.nodes()[0];
    setSelectedNodeId(first ? first.nodeId : null);
  };

  const handleDisconnect = () => {
    bus.disconnect();
    setSelectedNodeId(null);
  };

  const handleStopAll = () => {
    if (!bus.isConnected) return;
    const stopped = bus.stopAllImmediate();
    bus.emitStatus(
      `STOP ALL: SLEEP sent to ${stopped.length > 0 ? stopped.join(', ') : 'no drive'}`
    );
  };

  const handleAskEmergencyStop = () => {
    if (!bus.isConnected) return;
    const targets = nodes.filter((n) => n.isUnimoc).map((n) => n.nodeId);
    if (targets.length === 0) {
      handleStopAll();
      return;
    }
    setEstopConfirmOpen(true);
  };

  const handleConfirmEmergencyStop = () => {
    setEstopConfirmOpen(false);
    const targets = nodes.filter((n) => n.isUnimoc).map((n) => n.nodeId);
    const result = bus.emergencyStopAll(targets);
    const answered = Object.entries(result)
      .filter(([, status]) => status === 0)
      .map(([n]) => n);
    bus.emitStatus(
      `EMERGENCY STOP sent; confirmed by ${answered.length > 0 ? answered.join(', ') : 'no node'}`
    );
  };

  const tabs: { id: TabId; label: string }[] = [
    { id: 'nodes', label: `Nodes (${nodes.length})` },
    { id: 'registers', label: 'Registers' },
    { id: 'control', label: 'Control' },
    { id: 'simulation', label: 'Simulation' },
    { id: 'plot', label: 'Plot' },
    { id: 'cymon', label: 'Cymon Scope / Expert' },
    { id: 'profiles', label: 'Profiles' },
    { id: 'log', label: `Log (${bus.logs.length})` },
    { id: 'cli', label: 'cypilot-ctl CLI' },
    { id: 'audit', label: 'Code & CI Audit' },
  ];

  const watchdogHealthy = bus.isConnected && !bus.simulateUiStall && !bus.watchdogTripped;

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#F8FAFC] text-slate-900">
      {/* Main Toolbar (Responsive for phone viewports and full-width desktop) */}
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-300 bg-white px-2.5 py-2 sm:px-4">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <span className="font-mono text-xs sm:text-sm font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
            cypilot 0.1.0.dev0
          </span>

          <div className="hidden h-4 w-px bg-slate-200 sm:block" />

          <button
            type="button"
            disabled={bus.isConnected}
            onClick={() => setConnectDialogOpen(true)}
            className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            Connect...
          </button>

          <button
            type="button"
            disabled={!bus.isConnected}
            onClick={handleDisconnect}
            className="rounded border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-800 hover:bg-slate-100 disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            Disconnect
          </button>

          {bus.isConnected && bus.interfaceSpec && (
            <button
              type="button"
              onClick={() => setConnectDialogOpen(true)}
              title="Click to switch CAN interface or local node-ID"
              className="rounded border border-slate-200 bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-700 hover:bg-slate-100 whitespace-nowrap shrink-0"
            >
              {bus.interfaceSpec.text} <span className="hidden md:inline">· MTU {bus.interfaceSpec.mtu} · node {bus.currentLocalNodeId}</span>
            </button>
          )}
        </div>

        {/* Always-Reachable Safety Controls + Theme Toggle */}
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => setDarkMode((d) => !d)}
            title={darkMode ? 'Switch to Light theme' : 'Switch to Dark theme'}
            className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap shrink-0"
          >
            {darkMode ? <Sun className="h-3.5 w-3.5 text-amber-400" /> : <Moon className="h-3.5 w-3.5 text-slate-600" />}
            <span className="hidden sm:inline">{darkMode ? 'Light' : 'Dark'}</span>
          </button>

          <label
            className="flex cursor-pointer items-center gap-1.5 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700 hover:bg-slate-100 whitespace-nowrap shrink-0"
            title="Test the 0.3 s UI watchdog: stops feeding the bus thread so engaged drives automatically go to SLEEP"
          >
            <input
              type="checkbox"
              checked={bus.simulateUiStall}
              onChange={(e) => {
                bus.simulateUiStall = e.target.checked;
                if (!e.target.checked) {
                  bus.feedWatchdog();
                }
                setRenderTick((t) => t + 1);
              }}
              className="rounded border-slate-300 text-red-600"
            />
            <span className="hidden md:inline">Simulate UI Stall (&gt;0.3s Watchdog)</span>
            <span className="md:hidden">Stall Test</span>
          </label>

          <button
            type="button"
            onClick={handleStopAll}
            title="SLEEP to every drive and zero setpoints, at once"
            className="rounded bg-[#c62828] px-3 py-1.5 text-xs font-bold text-white shadow-xs hover:bg-red-800 whitespace-nowrap shrink-0"
          >
            STOP ALL <span className="hidden sm:inline">(Esc)</span>
          </button>

          <button
            type="button"
            onClick={handleAskEmergencyStop}
            title="ExecuteCommand EMERGENCY_STOP to every UNIMOC node; latched until a restart"
            className="rounded border border-red-300 bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-[#c62828] hover:bg-red-100 whitespace-nowrap shrink-0"
          >
            E-Stop <span className="hidden sm:inline">(Shift+Esc)</span>
          </button>
        </div>
      </header>

      {/* Full-Width Tabbed Workspace (Fits Phone Viewports & Uses Full Desktop Width) */}
      <main className="flex flex-1 flex-col overflow-hidden bg-white">
        {/* Scrollable Tab Bar + Active Node Selector */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-100 px-2 pt-1.5">
          <div className="flex max-w-full items-center overflow-x-auto">
            {tabs.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`rounded-t border-t border-x px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                    active
                      ? 'border-slate-300 bg-white font-semibold text-slate-900'
                      : 'border-transparent text-slate-600 hover:bg-slate-200/60 hover:text-slate-900'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className="mb-1 flex flex-wrap items-center gap-2 shrink-0">
            {/* Active Node Quick Selector */}
            {nodes.length > 0 && (
              <div className="flex items-center gap-1.5 text-xs">
                <span className="hidden font-mono text-[11px] text-slate-500 sm:inline">Node:</span>
                <select
                  value={selectedNodeId ?? ''}
                  onChange={(e) =>
                    setSelectedNodeId(e.target.value ? Number(e.target.value) : null)
                  }
                  title="Select target Cyphal node for Registers, Control, Simulation, and Profiles"
                  className="rounded border border-slate-300 bg-white px-2 py-0.5 font-mono text-[11px] text-slate-800"
                >
                  {nodes.map((n) => (
                    <option key={n.nodeId} value={n.nodeId}>
                      #{n.nodeId} {n.name || '?'} ({healthName(n.health)} · {n.chips.join(', ') || 'generic'})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {activeTab !== 'log' && (
              <button
                type="button"
                onClick={() => setLogDockOpen((v) => !v)}
                className={`rounded border px-2 py-0.5 font-mono text-[11px] transition-colors whitespace-nowrap shrink-0 ${
                  logDockOpen
                    ? 'border-slate-700 bg-slate-800 text-white'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                }`}
                title="Toggle compact multi-node chronological log stream below active tab"
              >
                {logDockOpen ? 'Hide Log Stream' : `Log Stream (${bus.logs.length})`}
              </button>
            )}
          </div>
        </div>

        {/* Active Panel */}
        <div className="flex-1 overflow-hidden">
          {activeTab === 'nodes' && (
            <NodeTable
              nodes={nodes}
              selectedNodeId={selectedNodeId}
              onSelectNode={(id) => setSelectedNodeId(id)}
              capabilities={selectedCapsAndPorts.capabilities}
              ports={selectedCapsAndPorts.ports}
              onOpenTab={(tab) => setActiveTab(tab)}
            />
          )}
          {activeTab === 'registers' && <RegisterPanel bus={bus} node={selectedNode} />}
          {activeTab === 'control' && <ControlPanel bus={bus} node={selectedNode} />}
          {activeTab === 'simulation' && <SimulationPanel bus={bus} node={selectedNode} />}
          {activeTab === 'plot' && <PlotPanel bus={bus} />}
          {activeTab === 'cymon' && <CymonExpertPanel bus={bus} node={selectedNode} />}
          {activeTab === 'profiles' && <ProfilePanel bus={bus} node={selectedNode} />}
          {activeTab === 'log' && <LogPanel bus={bus} logs={bus.logs} />}
          {activeTab === 'cli' && <CliPanel bus={bus} />}
          {activeTab === 'audit' && <CodeReviewPanel />}
        </div>

        {/* Compact Multi-Node Chronological Log Dock (auto-collapsed on Plot & Cymon Scope so plots get full space unless toggled) */}
        {activeTab !== 'log' && activeTab !== 'plot' && activeTab !== 'cymon' && logDockOpen && (
          <div className="h-40 sm:h-44 shrink-0 border-t border-slate-300">
            <LogPanel
              bus={bus}
              logs={bus.logs}
              compactDock
              onCloseDock={() => setLogDockOpen(false)}
            />
          </div>
        )}
      </main>

      {/* Bottom QStatusBar */}
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-300 bg-slate-100 px-3 py-1 font-mono text-xs text-slate-700">
        <div className="truncate max-w-full sm:max-w-[55%]">{bus.latestStatus}</div>
        <div className="flex items-center gap-2.5 text-[11px] text-slate-600 shrink-0">
          <div
            className="flex items-center gap-2"
            title="UI-to-bus watchdog heartbeat: feeds every 100 ms; bus thread forces SLEEP after 300 ms of silence"
          >
            <span className="relative flex h-2.5 w-2.5 items-center justify-center">
              {watchdogHealthy && watchdogFlash && (
                <span className="absolute inline-flex h-3.5 w-3.5 rounded-full bg-emerald-400/50" />
              )}
              <span
                className={`relative inline-flex h-2 w-2 rounded-full transition-all duration-75 ${
                  !bus.isConnected
                    ? 'bg-slate-400'
                    : bus.watchdogTripped
                      ? 'bg-red-600 shadow-[0_0_6px_rgba(220,38,38,0.85)]'
                      : bus.simulateUiStall
                        ? 'bg-amber-500'
                        : watchdogFlash
                          ? 'scale-110 bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.95)]'
                          : 'bg-emerald-800/35'
                }`}
              />
            </span>
            <span>
              Watchdog:{' '}
              {!bus.isConnected
                ? 'disconnected'
                : bus.watchdogTripped
                  ? 'TRIPPED (SLEEP)'
                  : bus.simulateUiStall
                    ? `STALLED (${bus.watchdogAgeMs} ms)`
                    : `100 ms feed (Δt ${bus.lastFeedDeltaMs} ms · #${bus.feedCount})`}
            </span>
          </div>
          <span className="hidden text-slate-400 sm:inline">·</span>
          <span className="hidden text-slate-500 sm:inline">UNIMOC DSDL v0.2.0</span>
        </div>
      </footer>

      {/* Connect Dialog */}
      <ConnectDialog
        open={connectDialogOpen}
        onClose={() => setConnectDialogOpen(false)}
        onConnect={handleConnect}
      />

      {/* Emergency Stop Confirmation Modal */}
      {estopConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md rounded border border-slate-300 bg-white p-4 shadow-lg">
            <h3 className="text-sm font-semibold text-slate-900">Emergency stop</h3>
            <p className="mt-2 text-xs text-slate-600">
              Send EMERGENCY_STOP to nodes{' '}
              {nodes
                .filter((n) => n.isUnimoc)
                .map((n) => n.nodeId)
                .join(', ')}
              ? They stay stopped until a restart.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEstopConfirmOpen(false)}
                className="rounded border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                No
              </button>
              <button
                type="button"
                onClick={handleConfirmEmergencyStop}
                className="rounded bg-[#c62828] px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-red-800"
              >
                Yes, Send EMERGENCY_STOP
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;
