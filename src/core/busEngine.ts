// SPDX-License-Identifier: Apache-2.0
/**
 * Complete Cyphal bus engine, session discovery, UNIMOC drive plant physics,
 * per-node readiness controller, 300ms UI watchdog, recovery state machines,
 * and cypilot-ctl CLI execution engine.
 * Ported from src/cypilot/core/session.py, src/cypilot/core/control.py, and src/cypilot/cli.py
 */

import {
  Capability,
  DIAGNOSTIC_RECORD_SUBJECT,
  EXECUTE_COMMAND_SERVICE,
  Port,
  PortList,
  READINESS_FOLLOWS_NODE_ID,
  REGISTER_LIST_SERVICE,
  SETPOINTS,
  UNSET_PORT_ID,
  capabilities,
  ports,
} from './capabilities';
import {
  Profile,
  createProfileFromRegisters,
  diffProfile,
  isSkippedOnLoad,
  loadProfileSync,
  profileFromJson,
  profileToJson,
} from './profiles';
import {
  Register,
  RegisterKind,
  RegisterValue,
  WriteResult,
  formatRegisterFlags,
  formatRegisterType,
  parseLike,
} from './registers';
import { Recorder, RecordingSnapshot, Source, discoverSources, makeSource } from './signals';
import {
  SIM_ADVANCE,
  SIM_CYCLE_COUNT,
  SIM_CYCLE_PERIOD,
  SIM_PAUSED,
  SIM_PREFIX,
  SIM_RESET,
  SimStatus,
  SimulationError,
  makeSimStatus,
} from './simControl';
import {
  Chip,
  Health,
  Mode,
  PowerStage,
  computeChips,
  decodeVendorStatus,
  encodeVendorStatus,
} from './status';
import {
  CYMON_DRIVE_VARIABLES,
  CymonBufferInfo,
  CymonCaptureSetup,
  CymonCaptureShot,
  CymonVariable,
  DEFAULT_CYMON_BUFFER_INFO,
  synthesizeCymonCaptureShot,
} from './cymonScope';
import { InterfaceSpec } from './transport';

export const KEEPALIVE_PERIOD_MS = 50; // 20 Hz
export const WATCHDOG_TIMEOUT_MS = 300; // 0.3 s
export const STANDBY_HOLD_MS = 1000; // 1.0 s

export const SLEEP = 0;
export const STANDBY = 2;
export const ENGAGED = 3;

export const COMMANDS: Record<string, number> = {
  restart: 65535,
  'factory-reset': 65532,
  'emergency-stop': 65531,
  store: 65530,
};

export const COMMAND_STATUS: Record<number, string> = {
  0: 'success',
  1: 'failure',
  2: 'not authorized',
  3: 'bad command',
  4: 'bad parameter',
  5: 'bad state',
  6: 'internal error',
};

export const SEVERITY_NAMES = [
  'trace',
  'debug',
  'info',
  'notice',
  'warning',
  'error',
  'critical',
  'alert',
] as const;

export interface LogRecord {
  readonly id: number;
  readonly received: number; // epoch seconds
  readonly nodeId: number | null;
  readonly severity: number; // 0..7
  readonly text: string;
}

export interface NodeSummary {
  readonly nodeId: number;
  readonly health: Health;
  readonly mode: Mode;
  readonly vendorCode: number;
  readonly uptime: number;
  readonly name: string | null;
  readonly softwareVersion: [number, number] | null;
  readonly hardwareVersion: [number, number] | null;
  readonly uniqueIdHex: string;
  readonly vcsRevision: number | null;
  readonly unimoc: boolean | null;
  readonly isUnimoc: boolean;
  readonly chips: Chip[];
}

export enum SetpointMode {
  CURRENT = 'current_setpoint', // i_d, i_q [A]
  TORQUE = 'torque_setpoint', // [N m]
  SPEED = 'speed_setpoint', // mechanical [rad/s]
  POSITION = 'position_setpoint', // mechanical [rad]
}

export function setpointComponents(mode: SetpointMode): number {
  return mode === SetpointMode.CURRENT ? 2 : 1;
}

export const SETPOINT_UNITS: Record<SetpointMode, string[]> = {
  [SetpointMode.CURRENT]: ['i_d [A]', 'i_q [A]'],
  [SetpointMode.TORQUE]: ['torque [N m]'],
  [SetpointMode.SPEED]: ['speed [rad/s]'],
  [SetpointMode.POSITION]: ['position [rad]'],
};

export interface DriveTarget {
  readonly nodeId: number;
  readonly readiness: number;
  readonly setpoints: Partial<Record<SetpointMode, number>>;
}

export interface Recovery {
  readonly steps: string[];
  readonly ready: boolean;
}

export class ControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlError';
  }
}

interface ActiveSetpoint {
  mode: SetpointMode;
  subject: number;
  target: number[];
  value: number[];
  rampRemaining: number; // seconds
}

interface SimulatedNodeState {
  nodeId: number;
  defaultRole: string;
  isUnimoc: boolean;
  isSimulation: boolean;
  localControlDefault: boolean;
  wheelIndex: number;
  uptime: number;
  health: Health;
  mode: Mode;
  powerStage: PowerStage;
  engaged: boolean;
  tripLatched: boolean;
  emergencyStop: boolean;
  settingsPending: boolean;
  localControl: boolean;
  registers: Map<string, Register>;
  flashRegisters: Map<string, RegisterValue>;
  // Plant state
  paused: boolean;
  cycleCount: number;
  cyclePeriodNs: number;
  idCurrent: number;
  iqCurrent: number;
  torqueNm: number;
  speedRadS: number;
  positionRad: number;
  dcLinkV: number;
  fetTempC: number;
  motorTempC: number;
  foreignMasterNodeId: number | null;
}

function makeReg(
  name: string,
  kind: RegisterKind,
  content: number[] | boolean[] | string | Uint8Array,
  mutable = true,
  persistent = true,
  meta?: { unit?: string; description?: string; min?: number; max?: number }
): Register {
  return {
    name,
    value: new RegisterValue(kind, content),
    mutable,
    persistent,
    unit: meta?.unit,
    description: meta?.description,
    min: meta?.min,
    max: meta?.max,
  };
}

function makePortRegs(
  kind: 'pub' | 'sub' | 'srv',
  name: string,
  portId: number,
  typeName: string
): Register[] {
  return [
    makeReg(`uavcan.${kind}.${name}.id`, 'natural16', [portId], true, true, {
      description: `Subject/service ID for ${kind}.${name} (65534=node-ID derived, 65535=disabled)`,
    }),
    makeReg(`uavcan.${kind}.${name}.type`, 'string', typeName, false, false, {
      description: `DSDL data type of ${kind}.${name}`,
    }),
  ];
}

function buildUnimocDriveRegisters(
  nodeId: number,
  roleName: string,
  wheelIndex: number,
  isSim: boolean,
  iMaxDefault = 15.0,
  polePairsDefault = 15
): Register[] {
  const uniqueBytes = new Uint8Array([0x55, 0x4e, 0x49, 0x4d, 0x4f, 0x43, 0x00, nodeId]);
  const regs: Register[] = [
    // uavcan.node.*
    makeReg('uavcan.node.id', 'natural16', [nodeId], true, true, {
      min: 0,
      max: 127,
      description: 'Cyphal node-ID on the CAN bus (takes effect after restart)',
    }),
    makeReg('uavcan.node.description', 'string', roleName, true, true, {
      description: 'User-assigned node role label returned in GetInfo',
    }),
    makeReg('uavcan.node.unique_id', 'unstructured', uniqueBytes, false, false, {
      description: 'Hardware 128-bit unique identifier',
    }),

    // uavcan.sub.*
    ...makePortRegs('sub', 'readiness', READINESS_FOLLOWS_NODE_ID, 'reg.udral.service.common.Readiness.0.1'),
    ...makePortRegs('sub', 'current_setpoint', 107, 'unimoc.drive.CurrentSetpoint.0.1'),
    ...makePortRegs('sub', 'torque_setpoint', 100, 'uavcan.si.unit.torque.Scalar.1.0'),
    ...makePortRegs('sub', 'speed_setpoint', 101, 'uavcan.si.unit.angular_velocity.Scalar.1.0'),
    ...makePortRegs('sub', 'position_setpoint', 102, 'uavcan.si.unit.angle.Scalar.1.0'),
    ...makePortRegs('sub', 'wheel_command', 110, 'unimoc.cart.WheelCommand.0.1'),

    // uavcan.pub.*
    ...makePortRegs('pub', 'telemetry', 212, 'unimoc.drive.Telemetry.0.1'),
    ...makePortRegs('pub', 'drive_status', 210, 'unimoc.cart.DriveStatus.0.1'),

    // uavcan.srv.cymon_* & cymon_trigger shared trigger subject
    ...makePortRegs('srv', 'cymon_variables', 120, 'cymon.GetVariableList.0.1'),
    ...makePortRegs('srv', 'cymon_buffer_info', 121, 'cymon.GetBufferInfo.0.1'),
    ...makePortRegs('srv', 'cymon_setup', 122, 'cymon.SetupCapture.0.1'),
    ...makePortRegs('srv', 'cymon_arm', 123, 'cymon.ArmTrigger.0.1'),
    ...makePortRegs('srv', 'cymon_read', 124, 'cymon.ReadBuffer.0.1'),
    ...makePortRegs('pub', 'cymon_trigger', 520, 'cymon.TriggerEvent.0.1'),
    ...makePortRegs('sub', 'cymon_trigger', 520, 'cymon.TriggerEvent.0.1'),

    // unimoc.motor.*
    makeReg('unimoc.motor.pole_pairs', 'natural8', [polePairsDefault], true, true, {
      min: 1,
      max: 64,
      description: 'Number of rotor magnetic pole pairs',
    }),
    makeReg('unimoc.motor.r_phase', 'real32', [0.085], true, true, {
      unit: 'Ohm',
      min: 0.001,
      max: 50.0,
      description: 'Stator phase resistance',
    }),
    makeReg('unimoc.motor.l_d', 'real32', [0.00018], true, true, {
      unit: 'H',
      min: 1e-6,
      max: 0.1,
      description: 'Direct-axis inductance',
    }),
    makeReg('unimoc.motor.l_q', 'real32', [0.00021], true, true, {
      unit: 'H',
      min: 1e-6,
      max: 0.1,
      description: 'Quadrature-axis inductance',
    }),
    makeReg('unimoc.motor.flux_linkage', 'real32', [0.0185], true, true, {
      unit: 'Wb',
      min: 0.0005,
      max: 2.0,
      description: 'Permanent magnet flux linkage',
    }),
    makeReg('unimoc.motor.limits.i_max', 'real32', [iMaxDefault], true, true, {
      unit: 'A',
      min: 0.5,
      max: 120.0,
      description: 'Maximum phase current magnitude (validated against power stage rating)',
    }),
    makeReg('unimoc.motor.limits.omega_max', 'real32', [160.0], true, true, {
      unit: 'rad/s',
      min: 1.0,
      max: 2000.0,
      description: 'Maximum mechanical angular velocity',
    }),
    makeReg('unimoc.motor.limits.torque_max', 'real32', [28.0], true, true, {
      unit: 'N m',
      min: 0.1,
      max: 500.0,
      description: 'Maximum shaft electromagnetic torque',
    }),

    // unimoc.control.*
    makeReg('unimoc.control.command_timeout', 'real32', [0.5], true, true, {
      unit: 's',
      min: 0.05,
      max: 10.0,
      description: 'Readiness & setpoint refresh timeout before automatic disengage',
    }),
    makeReg('unimoc.control.current_kp', 'real32', [0.42], true, true, {
      unit: 'V/A',
      min: 0.01,
      max: 50.0,
      description: 'FOC current controller proportional gain',
    }),
    makeReg('unimoc.control.current_ki', 'real32', [240.0], true, true, {
      unit: 'V/(A s)',
      min: 0.0,
      max: 50000.0,
      description: 'FOC current controller integral gain',
    }),
    makeReg('unimoc.control.speed_kp', 'real32', [0.85], true, true, {
      unit: 'A/(rad/s)',
      min: 0.0,
      max: 200.0,
      description: 'Velocity loop proportional gain',
    }),
    makeReg('unimoc.control.speed_ki', 'real32', [12.0], true, true, {
      unit: 'A/rad',
      min: 0.0,
      max: 5000.0,
      description: 'Velocity loop integral gain',
    }),

    // unimoc.power.*
    makeReg('unimoc.power.v_dc_min', 'real32', [36.0], true, true, {
      unit: 'V',
      min: 10.0,
      max: 55.0,
      description: 'Undervoltage trip threshold',
    }),
    makeReg('unimoc.power.v_dc_derate', 'real32', [54.0], true, true, {
      unit: 'V',
      min: 12.0,
      max: 57.5,
      description: 'Regenerative braking derating start voltage (must be < v_dc_max)',
    }),
    makeReg('unimoc.power.v_dc_max', 'real32', [58.0], true, true, {
      unit: 'V',
      min: 15.0,
      max: 65.0,
      description: 'Overvoltage trip threshold (latches trip bit 4 when exceeded)',
    }),

    // unimoc.cart.* & telemetry & settings
    makeReg('unimoc.cart.wheel', 'natural8', [wheelIndex], true, true, {
      min: 0,
      max: 3,
      description: 'Cart wheel index (0=FL, 1=FR, 2=RL, 3=RR)',
    }),
    makeReg('unimoc.telemetry.rate', 'natural16', [20], true, true, {
      unit: 'Hz',
      min: 1,
      max: 200,
      description: 'Publication frequency of unimoc.drive.Telemetry',
    }),
    makeReg('unimoc.can.bus_off_count', 'natural32', [0], false, false, {
      description: 'CAN controller bus-off recovery counter',
    }),
    makeReg('unimoc.settings.pending', 'bit', [false], false, false, {
      description: 'True when modified settings wait for drive disengage or flash store',
    }),
  ];

  if (isSim) {
    regs.push(
      makeReg(SIM_PAUSED, 'bit', [false], true, false, {
        description: 'Pause the 16 kHz virtual control clock',
      }),
      makeReg(SIM_ADVANCE, 'natural32', [0], true, false, {
        description: 'Advance paused simulation by N control cycles (max 16000 per write)',
      }),
      makeReg(SIM_RESET, 'natural8', [0], true, false, {
        description: 'Reset plant to standstill and virtual clock to 0 (refused while enabled)',
      }),
      makeReg(SIM_CYCLE_COUNT, 'natural64', [256000], false, false, {
        description: 'Total 16 kHz control cycles executed since boot/reset',
      }),
      makeReg(SIM_CYCLE_PERIOD, 'natural32', [62500], false, false, {
        unit: 'ns',
        description: 'Control loop period in nanoseconds (62500 ns = 16 kHz)',
      }),
      // Plant inputs (discovered dynamically by SimulationPanel)
      makeReg('unimoc.sim.shaft_mode', 'natural8', [0], true, false, {
        min: 0,
        max: 2,
        description: '0 = free inertia shaft, 1 = speed-imposed dynamometer, 2 = locked rotor',
      }),
      makeReg('unimoc.sim.imposed_speed', 'real32', [0.0], true, false, {
        unit: 'rad/s',
        min: -500.0,
        max: 500.0,
        description: 'Externally imposed rotor speed when shaft_mode = 1',
      }),
      makeReg('unimoc.sim.load_torque', 'real32', [0.2], true, false, {
        unit: 'N m',
        min: -100.0,
        max: 100.0,
        description: 'External mechanical load torque opposing rotation',
      }),
      makeReg('unimoc.sim.dc_link_voltage', 'real32', [48.0], true, false, {
        unit: 'V',
        min: 0.0,
        max: 80.0,
        description: 'Simulated DC bus voltage (>58.0 V triggers overvoltage trip bit 4)',
      }),
      makeReg('unimoc.sim.external_enable', 'bit', [true], true, false, {
        description: 'Hard-wired E-stop loop input (false puts power stage into BLOCKED state)',
      }),
      makeReg('unimoc.sim.ambient_temp', 'real32', [26.5], true, false, {
        unit: 'degC',
        min: -40.0,
        max: 125.0,
        description: 'Simulated ambient heatsink temperature',
      })
    );
  }

  return regs;
}

function buildGenericBmsRegisters(nodeId: number): Register[] {
  const uniqueBytes = new Uint8Array([0x42, 0x4d, 0x53, 0x00, 0x00, 0x00, 0x00, nodeId]);
  return [
    makeReg('uavcan.node.id', 'natural16', [nodeId], true, true),
    makeReg('uavcan.node.description', 'string', 'pack_bms', true, true),
    makeReg('uavcan.node.unique_id', 'unstructured', uniqueBytes, false, false),
    ...makePortRegs('pub', 'battery_status', 310, 'unimoc.cart.BatteryStatus.0.1'),
    makeReg('bms.cell_count', 'natural8', [13], false, true),
    makeReg('bms.nominal_capacity_ah', 'real32', [24.0], true, true),
    makeReg('bms.balance_threshold_mv', 'natural16', [15], true, true),
  ];
}

export class CypilotBusEngine {
  private spec: InterfaceSpec | null = null;
  private localNodeId = 127;
  private simNodes = new Map<number, SimulatedNodeState>();
  private engagedTargets = new Map<number, DriveTarget>();
  private standbyTargets = new Map<number, { target: DriveTarget; untilMs: number }>();
  private knownTargets = new Map<number, DriveTarget>();
  private setpoints = new Map<string, ActiveSetpoint>();
  private subscribedSources = new Set<string>();
  public liveRecorder = new Recorder();
  public savedProfiles = new Map<string, Profile>();
  public savedRecordings: RecordingSnapshot[] = [];
  public savedScopeShots: CymonCaptureShot[] = [];
  public rawBusFrames: {
    id: number;
    timestamp: number;
    direction: 'TX' | 'RX';
    kind: 'subject' | 'service';
    portId: number;
    nodeId: number;
    typeName: string;
    payload: string;
  }[] = [];

  private lastFeedMs = performance.now();
  public feedCount = 0;
  public lastFeedDeltaMs = 100;
  public watchdogTripped = false;
  public simulateUiStall = false;
  private logCounter = 1;
  private frameCounter = 1;
  public logs: LogRecord[] = [];
  public statusHistory: string[] = [];
  public latestStatus = 'not connected';

  private tickInterval: number | null = null;
  private listeners = new Set<() => void>();
  private broadcastChannel: BroadcastChannel | null = null;

  constructor() {
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      try {
        this.broadcastChannel = new BroadcastChannel('cypilot-bus-sync');
        this.broadcastChannel.onmessage = (ev) => {
          const msg = ev.data;
          if (!msg || typeof msg !== 'object') return;
          if (msg.type === 'scope_shot' && msg.shot) {
            this.savedScopeShots = [msg.shot, ...this.savedScopeShots.slice(0, 19)];
            this.notify();
          }
        };
      } catch {
        this.broadcastChannel = null;
      }
    }
    // Seed 2 realistic profiles for quick profile comparison and loading
    const defaultRegs = buildUnimocDriveRegisters(10, 'FL drive', 0, true, 15.0, 15);
    const highTorqueRegs = buildUnimocDriveRegisters(10, 'FL drive (High Torque)', 0, true, 24.0, 15).map(
      (r) => {
        if (r.name === 'unimoc.control.current_kp') {
          return { ...r, value: new RegisterValue('real32', [0.65]) };
        }
        if (r.name === 'unimoc.control.speed_kp') {
          return { ...r, value: new RegisterValue('real32', [1.25]) };
        }
        return r;
      }
    );
    const benchSafeRegs = buildUnimocDriveRegisters(10, 'Bench Current-Limited', 0, true, 5.0, 7);

    this.savedProfiles.set(
      'fl_drive_default.json',
      createProfileFromRegisters(defaultRegs, {
        nodeName: 'FL drive',
        softwareVersion: [0, 2],
        vcsRevision: 0xa4f210,
      })
    );
    this.savedProfiles.set(
      'high_torque_24A.json',
      createProfileFromRegisters(highTorqueRegs, {
        nodeName: 'FL drive',
        softwareVersion: [0, 2],
        vcsRevision: 0xa4f210,
      })
    );
    this.savedProfiles.set(
      'bench_limit_5A_7pp.json',
      createProfileFromRegisters(benchSafeRegs, {
        nodeName: 'bench_drive',
        softwareVersion: [0, 2],
        vcsRevision: 0xa4f210,
      })
    );
  }

  subscribeChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    for (const cb of this.listeners) {
      cb();
    }
  }

  public emitStatus(text: string, mark = true): void {
    this.latestStatus = text;
    this.statusHistory.push(text);
    if (this.statusHistory.length > 200) {
      this.statusHistory.shift();
    }
    if (mark && this.isConnected) {
      this.liveRecorder.mark(text);
    }
    this.notify();
  }

  public emitLog(nodeId: number | null, severity: number, text: string, received?: number): void {
    this.logs.push({
      id: this.logCounter++,
      received: received ?? Date.now() / 1000,
      nodeId,
      severity,
      text,
    });
    if (this.logs.length > 5000) {
      this.logs.shift();
    }
    this.notify();
  }

  get isConnected(): boolean {
    return this.spec !== null;
  }

  get interfaceSpec(): InterfaceSpec | null {
    return this.spec;
  }

  get currentLocalNodeId(): number {
    return this.localNodeId;
  }

  get watchdogAgeMs(): number {
    return Math.max(0, Math.round(performance.now() - this.lastFeedMs));
  }

  public feedWatchdog(): boolean {
    if (this.isConnected && !this.simulateUiStall) {
      const now = performance.now();
      this.lastFeedDeltaMs = Math.max(1, Math.round(now - this.lastFeedMs));
      this.lastFeedMs = now;
      this.feedCount += 1;
      if (this.watchdogTripped) {
        this.watchdogTripped = false;
      }
      return true;
    }
    return false;
  }

  public connect(spec: InterfaceSpec, localNodeId = 127): void {
    this.disconnect();
    this.spec = spec;
    this.localNodeId = localNodeId;
    this.simNodes.clear();
    this.engagedTargets.clear();
    this.standbyTargets.clear();
    this.knownTargets.clear();
    this.setpoints.clear();
    this.subscribedSources.clear();
    this.watchdogTripped = false;
    this.simulateUiStall = false;
    this.lastFeedMs = performance.now();
    this.lastFeedDeltaMs = 100;

    if (spec.text === 'socketcan:vcan0') {
      // 4 wheel drives + 1 e-bike (local control) + 1 BMS
      this.createSimNode(10, 'FL drive', 0, true, true, false, 15.0, 15);
      this.createSimNode(11, 'FR drive', 1, true, true, false, 15.0, 15);
      this.createSimNode(12, 'RL drive', 2, true, true, false, 18.0, 15);
      this.createSimNode(13, 'RR drive', 3, true, true, false, 18.0, 15);
      this.createSimNode(20, 'ebike_drive', 0, true, true, true, 12.0, 10);
      this.createGenericNode(30, 'pack_bms');
    } else if (spec.text.startsWith('slcan:/dev/pts/')) {
      // Single simulated UNIMOC drive (as in tests/sim/)
      this.createSimNode(10, 'unimoc', 0, true, true, false, 15.0, 15);
    } else {
      // Hardware bench bus
      this.createSimNode(10, 'bench_drive', 0, true, false, false, 15.0, 15);
      this.createSimNode(11, 'load_dyno', 1, true, false, false, 20.0, 15);
    }

    // Automatically subscribe 10/telemetry so live plots have immediate data if checked
    this.subscribedSources.add('10/telemetry');

    this.emitStatus(`connected to ${spec.text}`, false);

    // Emit initial chronological uavcan.diagnostic.Record.1.1 stream across all active bus nodes
    const baseSec = Date.now() / 1000 - 0.35;
    let step = 0;
    this.emitLog(
      null,
      2,
      `Session opened on ${spec.text} (MTU ${spec.mtu}, local node ${localNodeId})`,
      baseSec + step++ * 0.035
    );
    for (const node of this.simNodes.values()) {
      const descReg = node.registers.get('uavcan.node.description');
      const role = descReg && typeof descReg.value.content === 'string' ? descReg.value.content : node.defaultRole;
      if (node.isUnimoc) {
        this.emitLog(
          node.nodeId,
          2,
          `UNIMOC v0.2.0 (${role}) online · readiness sub=${1024 + node.nodeId}, telemetry pub=${200 + node.wheelIndex}`,
          baseSec + step++ * 0.038
        );
        if (node.localControl) {
          this.emitLog(
            node.nodeId,
            3,
            `local_control=1 active on ${role}: hardware throttle/PAS master, CAN readiness ignored`,
            baseSec + step++ * 0.032
          );
        } else {
          this.emitLog(
            node.nodeId,
            1,
            `FOC observer ready (v_dc=${node.dcLinkV.toFixed(1)} V, T_fet=${node.fetTempC.toFixed(1)} °C, stage=DISABLED)`,
            baseSec + step++ * 0.028
          );
        }
      } else {
        this.emitLog(
          node.nodeId,
          3,
          `BMS (${role}) online · pack=${node.dcLinkV.toFixed(1)} V, SoC=84.5%, cell ΔV=4 mV, contactor CLOSED`,
          baseSec + step++ * 0.04
        );
      }
    }

    this.tickInterval = window.setInterval(() => this.tick(), KEEPALIVE_PERIOD_MS);
    this.notify();
  }

  public disconnect(reason = ''): void {
    if (this.tickInterval !== null) {
      window.clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    for (const node of this.simNodes.values()) {
      node.engaged = false;
      if (node.powerStage === PowerStage.ENABLED) {
        node.powerStage = PowerStage.DISABLED;
      }
    }
    this.spec = null;
    this.simNodes.clear();
    this.engagedTargets.clear();
    this.standbyTargets.clear();
    this.setpoints.clear();
    this.subscribedSources.clear();
    this.emitStatus(reason ? `connection failed: ${reason}` : 'disconnected', false);
    this.notify();
  }

  private createSimNode(
    nodeId: number,
    role: string,
    wheelIndex: number,
    isUnimoc: boolean,
    isSimulation: boolean,
    localControl: boolean,
    iMax: number,
    polePairs: number
  ): void {
    const regList = buildUnimocDriveRegisters(nodeId, role, wheelIndex, isSimulation, iMax, polePairs);
    const regMap = new Map<string, Register>();
    const flashMap = new Map<string, RegisterValue>();
    for (const r of regList) {
      regMap.set(r.name, r);
      if (r.persistent) {
        flashMap.set(r.name, r.value);
      }
    }
    this.simNodes.set(nodeId, {
      nodeId,
      defaultRole: role,
      isUnimoc,
      isSimulation,
      localControlDefault: localControl,
      wheelIndex,
      uptime: 120 + nodeId * 3,
      health: Health.NOMINAL,
      mode: Mode.OPERATIONAL,
      powerStage: localControl ? PowerStage.ENABLED : PowerStage.DISABLED,
      engaged: false,
      tripLatched: false,
      emergencyStop: false,
      settingsPending: false,
      localControl,
      registers: regMap,
      flashRegisters: flashMap,
      paused: false,
      cycleCount: 256000,
      cyclePeriodNs: 62500,
      idCurrent: 0.0,
      iqCurrent: 0.0,
      torqueNm: 0.0,
      speedRadS: 0.0,
      positionRad: 0.0,
      dcLinkV: 48.0,
      fetTempC: 28.4,
      motorTempC: 30.1,
      foreignMasterNodeId: null,
    });
  }

  private createGenericNode(nodeId: number, role: string): void {
    const regList = buildGenericBmsRegisters(nodeId);
    const regMap = new Map<string, Register>();
    const flashMap = new Map<string, RegisterValue>();
    for (const r of regList) {
      regMap.set(r.name, r);
      if (r.persistent) flashMap.set(r.name, r.value);
    }
    this.simNodes.set(nodeId, {
      nodeId,
      defaultRole: role,
      isUnimoc: false,
      isSimulation: false,
      localControlDefault: false,
      wheelIndex: 0,
      uptime: 410,
      health: Health.NOMINAL,
      mode: Mode.OPERATIONAL,
      powerStage: PowerStage.DISABLED,
      engaged: false,
      tripLatched: false,
      emergencyStop: false,
      settingsPending: false,
      localControl: false,
      registers: regMap,
      flashRegisters: flashMap,
      paused: false,
      cycleCount: 0,
      cyclePeriodNs: 62500,
      idCurrent: 0,
      iqCurrent: 0,
      torqueNm: 0,
      speedRadS: 0,
      positionRad: 0,
      dcLinkV: 48.2,
      fetTempC: 25.0,
      motorTempC: 25.0,
      foreignMasterNodeId: null,
    });
  }

  private tickCount = 0;

  private tick(): void {
    if (!this.isConnected) return;
    this.tickCount++;
    const nowMs = performance.now();
    const dt = KEEPALIVE_PERIOD_MS / 1000;

    // 1. Watchdog check (300 ms without UI feed puts all engaged drives to SLEEP)
    if (this.engagedTargets.size > 0 && nowMs - this.lastFeedMs > WATCHDOG_TIMEOUT_MS) {
      this.watchdogTripped = true;
      const trippedNodes = Array.from(this.engagedTargets.keys());
      this.stopAllImmediate();
      this.emitStatus(
        `WATCHDOG TRIPPED (>0.3s UI stall): SLEEP sent to ${trippedNodes.join(', ')}`,
        true
      );
      this.emitLog(
        null,
        4,
        `UI watchdog timeout (${WATCHDOG_TIMEOUT_MS} ms): stopped readiness keep-alive for nodes ${trippedNodes.join(', ')}`
      );
      return;
    }

    // 2. Ramp active setpoints
    for (const sp of this.setpoints.values()) {
      if (sp.rampRemaining <= 0 || dt >= sp.rampRemaining) {
        sp.value = [...sp.target];
        sp.rampRemaining = 0;
      } else {
        const frac = dt / sp.rampRemaining;
        sp.value = sp.value.map((v, i) => v + (sp.target[i] - v) * frac);
        sp.rampRemaining -= dt;
      }
    }

    // 3. Expire standby holds
    for (const [nodeId, entry] of this.standbyTargets.entries()) {
      if (nowMs > entry.untilMs) {
        this.standbyTargets.delete(nodeId);
      }
    }

    // 4. Advance plant physics & telemetry for each node
    const nowSec = Date.now() / 1000;
    for (const node of this.simNodes.values()) {
      if (this.tickCount % 20 === 0) {
        node.uptime += 1;
      }

      if (!node.isUnimoc) {
        // Generic BMS telemetry
        const bmsSource = makeSource(node.nodeId, 'battery_status', 310, 'unimoc.cart.BatteryStatus.0.1');
        if (this.subscribedSources.has(bmsSource.key)) {
          this.liveRecorder.add(
            bmsSource,
            {
              pack_voltage: 48.2 + 0.05 * Math.sin(nowSec * 0.5),
              pack_current: this.engagedTargets.size * 1.8,
              soc_percent: 84.5,
              max_cell_temp: 27.2,
            },
            nowSec
          );
        }
        continue;
      }

      // Sync sim registers -> plant state
      if (node.isSimulation) {
        const extEnableReg = node.registers.get('unimoc.sim.external_enable');
        const extEnabled =
          extEnableReg && Array.isArray(extEnableReg.value.content)
            ? Boolean(extEnableReg.value.content[0])
            : true;

        const vDcReg = node.registers.get('unimoc.sim.dc_link_voltage');
        node.dcLinkV =
          vDcReg && Array.isArray(vDcReg.value.content) ? Number(vDcReg.value.content[0]) : 48.0;

        const vMaxReg = node.registers.get('unimoc.power.v_dc_max');
        const vMax = vMaxReg && Array.isArray(vMaxReg.value.content) ? Number(vMaxReg.value.content[0]) : 58.0;
        const vMinReg = node.registers.get('unimoc.power.v_dc_min');
        const vMin = vMinReg && Array.isArray(vMinReg.value.content) ? Number(vMinReg.value.content[0]) : 36.0;

        if (node.dcLinkV > vMax || node.dcLinkV < vMin) {
          if (!node.tripLatched) {
            node.tripLatched = true;
            node.powerStage = PowerStage.FAULT;
            node.health = Health.ADVISORY;
            node.engaged = false;
            this.engagedTargets.delete(node.nodeId);
            this.emitLog(
              node.nodeId,
              4,
              `DC link voltage trip latched (v_dc = ${node.dcLinkV.toFixed(1)} V, limits [${vMin}, ${vMax}] V)`
            );
          }
        }

        if (!extEnabled) {
          node.powerStage = PowerStage.BLOCKED;
          if (node.engaged) {
            node.engaged = false;
            this.engagedTargets.delete(node.nodeId);
            this.emitLog(node.nodeId, 4, 'disengaged: external enable missing (E-stop loop open)');
          }
        } else if (node.powerStage === PowerStage.BLOCKED) {
          node.powerStage = node.engaged ? PowerStage.ENABLED : PowerStage.DISABLED;
        }
      }

      // Advance simulation virtual cycles when not paused (16 kHz = 800 cycles per 50 ms)
      if (!node.paused) {
        node.cycleCount += 800;
        if (node.isSimulation) {
          node.registers.set(
            SIM_CYCLE_COUNT,
            makeReg(SIM_CYCLE_COUNT, 'natural64', [node.cycleCount], false, false)
          );
        }

        const loadReg = node.registers.get('unimoc.sim.load_torque');
        const loadTorque =
          loadReg && Array.isArray(loadReg.value.content) ? Number(loadReg.value.content[0]) : 0.2;
        const shaftModeReg = node.registers.get('unimoc.sim.shaft_mode');
        const shaftMode =
          shaftModeReg && Array.isArray(shaftModeReg.value.content) ? Number(shaftModeReg.value.content[0]) : 0;
        const imposedSpeedReg = node.registers.get('unimoc.sim.imposed_speed');
        const imposedSpeed =
          imposedSpeedReg && Array.isArray(imposedSpeedReg.value.content)
            ? Number(imposedSpeedReg.value.content[0])
            : 0;

        if (node.engaged) {
          node.powerStage = PowerStage.ENABLED;
          const target = this.engagedTargets.get(node.nodeId);
          let cmdId = 0;
          let cmdIq = 0;

          if (target) {
            const curSub = target.setpoints[SetpointMode.CURRENT];
            const trqSub = target.setpoints[SetpointMode.TORQUE];
            const spdSub = target.setpoints[SetpointMode.SPEED];
            const posSub = target.setpoints[SetpointMode.POSITION];

            const curSp =
              curSub !== undefined ? this.setpoints.get(`${SetpointMode.CURRENT}:${curSub}`) : undefined;
            const trqSp =
              trqSub !== undefined ? this.setpoints.get(`${SetpointMode.TORQUE}:${trqSub}`) : undefined;
            const spdSp =
              spdSub !== undefined ? this.setpoints.get(`${SetpointMode.SPEED}:${spdSub}`) : undefined;
            const posSp =
              posSub !== undefined ? this.setpoints.get(`${SetpointMode.POSITION}:${posSub}`) : undefined;

            if (curSp && (Math.abs(curSp.value[0]) > 1e-4 || Math.abs(curSp.value[1]) > 1e-4)) {
              cmdId = curSp.value[0];
              cmdIq = curSp.value[1];
            } else if (trqSp && Math.abs(trqSp.value[0]) > 1e-4) {
              cmdIq = trqSp.value[0] / 1.4;
            } else if (spdSp && Math.abs(spdSp.value[0]) > 1e-4) {
              const err = spdSp.value[0] - node.speedRadS;
              cmdIq = Math.max(-15, Math.min(15, err * 0.85));
            } else if (posSp) {
              const posErr = posSp.value[0] - node.positionRad;
              cmdIq = Math.max(-10, Math.min(10, posErr * 2.5 - node.speedRadS * 0.3));
            }
          }

          node.idCurrent = cmdId;
          node.iqCurrent = cmdIq;
          node.torqueNm = node.iqCurrent * 1.4; // k_t = 1.4 Nm/A

          if (shaftMode === 1) {
            node.speedRadS = imposedSpeed;
          } else if (shaftMode === 2) {
            node.speedRadS = 0;
          } else {
            const netTorque = node.torqueNm - loadTorque * Math.sign(node.speedRadS || node.torqueNm) - 0.04 * node.speedRadS;
            node.speedRadS += (netTorque / 0.025) * dt;
            if (Math.abs(node.iqCurrent) < 1e-3 && Math.abs(node.speedRadS) < 0.15) {
              node.speedRadS = 0;
            }
          }
          node.positionRad += node.speedRadS * dt;
          node.fetTempC = Math.min(85, 28.4 + 0.06 * (node.idCurrent ** 2 + node.iqCurrent ** 2));
          node.motorTempC = Math.min(95, 30.1 + 0.08 * (node.idCurrent ** 2 + node.iqCurrent ** 2));
        } else {
          node.idCurrent = 0;
          node.iqCurrent = 0;
          node.torqueNm = 0;
          node.speedRadS *= 0.88;
          if (Math.abs(node.speedRadS) < 0.05) node.speedRadS = 0;
          node.positionRad += node.speedRadS * dt;
          node.fetTempC = Math.max(26.5, node.fetTempC - 0.05);
        }
      }

      // Record subscribed telemetry sources
      const telSource = makeSource(node.nodeId, 'telemetry', 212, 'unimoc.drive.Telemetry.0.1');
      if (this.subscribedSources.has(telSource.key)) {
        this.liveRecorder.add(
          telSource,
          {
            control_cycles: node.cycleCount,
            engaged: node.engaged ? 1.0 : 0.0,
            i_d: Number(node.idCurrent.toFixed(4)),
            i_q: Number(node.iqCurrent.toFixed(4)),
            torque: Number(node.torqueNm.toFixed(4)),
            speed: Number(node.speedRadS.toFixed(4)),
            position: Number(node.positionRad.toFixed(4)),
            v_dc: Number(node.dcLinkV.toFixed(3)),
            fet_temp: Number(node.fetTempC.toFixed(2)),
            overcurrent_tripped: node.tripLatched ? 1.0 : 0.0,
          },
          nowSec
        );
      }

      const statusSource = makeSource(node.nodeId, 'drive_status', 210, 'unimoc.cart.DriveStatus.0.1');
      if (this.subscribedSources.has(statusSource.key)) {
        this.liveRecorder.add(
          statusSource,
          {
            engaged: node.engaged ? 1.0 : 0.0,
            speed: Number(node.speedRadS.toFixed(4)),
            torque: Number(node.torqueNm.toFixed(4)),
            v_dc: Number(node.dcLinkV.toFixed(3)),
            motor_temp: Number(node.motorTempC.toFixed(2)),
          },
          nowSec
        );
      }
    }

    // Periodic multi-node diagnostic telemetry records (every 6 seconds, rotating across online nodes)
    if (this.tickCount % 120 === 0 && this.simNodes.size > 0) {
      const nodeList = Array.from(this.simNodes.values()).sort((a, b) => a.nodeId - b.nodeId);
      const idx = Math.floor(this.tickCount / 120) % nodeList.length;
      const n = nodeList[idx];
      if (n.isUnimoc) {
        const stateTag = n.engaged ? 'ENGAGED' : PowerStage[n.powerStage];
        this.emitLog(
          n.nodeId,
          1,
          `diag: stage=${stateTag} v_dc=${n.dcLinkV.toFixed(1)}V i_q=${n.iqCurrent.toFixed(2)}A ω=${n.speedRadS.toFixed(2)}rad/s T_fet=${n.fetTempC.toFixed(1)}°C`,
          nowSec
        );
      } else {
        const totalIq = Array.from(this.simNodes.values()).reduce(
          (acc, item) => acc + Math.abs(item.iqCurrent),
          0
        );
        this.emitLog(
          n.nodeId,
          2,
          `bms: V_pack=${n.dcLinkV.toFixed(2)}V I_bus=${(totalIq * 0.45).toFixed(2)}A SoC=84.5% T_cell=27.2°C`,
          nowSec
        );
      }
    }

    if (this.tickCount % 2 === 0) {
      this.notify();
    }
  }

  public emitMultiNodeStatusRecords(): void {
    const baseSec = Date.now() / 1000;
    let offset = 0;
    for (const n of Array.from(this.simNodes.values()).sort((a, b) => a.nodeId - b.nodeId)) {
      const descReg = n.registers.get('uavcan.node.description');
      const role = descReg && typeof descReg.value.content === 'string' ? descReg.value.content : n.defaultRole;
      if (n.isUnimoc) {
        const stageName = PowerStage[n.powerStage];
        this.emitLog(
          n.nodeId,
          n.tripLatched || n.emergencyStop ? 4 : 2,
          `[${role}] stage=${stageName} engaged=${n.engaged ? 1 : 0} v_dc=${n.dcLinkV.toFixed(1)}V i_d=${n.idCurrent.toFixed(2)}A i_q=${n.iqCurrent.toFixed(2)}A ω=${n.speedRadS.toFixed(2)}rad/s cycles=${n.cycleCount}`,
          baseSec + offset * 0.008
        );
      } else {
        this.emitLog(
          n.nodeId,
          2,
          `[${role}] pack=${n.dcLinkV.toFixed(2)}V SoC=84.5% balance=OK isolation=OK`,
          baseSec + offset * 0.008
        );
      }
      offset += 1;
    }
  }

  // --- Discovery & Summaries -------------------------------------------------

  public nodes(): NodeSummary[] {
    const result: NodeSummary[] = [];
    for (const n of Array.from(this.simNodes.values()).sort((a, b) => a.nodeId - b.nodeId)) {
      const vendorCode = n.isUnimoc
        ? encodeVendorStatus({
            powerStage: n.powerStage,
            engaged: n.engaged,
            tripLatched: n.tripLatched,
            emergencyStop: n.emergencyStop,
            settingsPending: n.settingsPending,
            localControl: n.localControl,
          })
        : 0;
      const descReg = n.registers.get('uavcan.node.description');
      const name = descReg && typeof descReg.value.content === 'string' ? descReg.value.content : n.defaultRole;
      const chips = computeChips({
        online: true,
        health: n.health,
        vendorCode,
        unimoc: n.isUnimoc,
      });
      result.push({
        nodeId: n.nodeId,
        health: n.health,
        mode: n.mode,
        vendorCode,
        uptime: n.uptime,
        name,
        softwareVersion: [0, 2],
        hardwareVersion: [1, 0],
        uniqueIdHex: `554e494d4f4300${n.nodeId.toString(16).padStart(2, '0')}`,
        vcsRevision: 0xa4f210,
        unimoc: n.isUnimoc,
        isUnimoc: n.isUnimoc,
        chips,
      });
    }
    return result;
  }

  public portList(nodeId: number): PortList | null {
    const node = this.simNodes.get(nodeId);
    if (!node) return null;
    const nodePorts = ports(node.registers.values(), nodeId);
    const pubs = new Set<number>([DIAGNOSTIC_RECORD_SUBJECT]);
    const subs = new Set<number>();
    for (const p of nodePorts) {
      if (p.kind === 'pub' && p.portId !== null) pubs.add(p.portId);
      if (p.kind === 'sub' && p.portId !== null) subs.add(p.portId);
    }
    // If another node acts as foreign master on a readiness subject
    if (node.foreignMasterNodeId !== null) {
      pubs.add(1024 + node.foreignMasterNodeId);
    }
    return {
      publishers: pubs,
      subscribers: subs,
      servers: new Set([REGISTER_LIST_SERVICE, EXECUTE_COMMAND_SERVICE]),
    };
  }

  public nodeCapabilities(nodeId: number): { capabilities: Capability[]; ports: Port[] } {
    const node = this.simNodes.get(nodeId);
    if (!node) return { capabilities: [], ports: [] };
    const summary = this.nodes().find((n) => n.nodeId === nodeId);
    const regs = Array.from(node.registers.values());
    const pList = this.portList(nodeId);
    return {
      capabilities: capabilities(regs, nodeId, {
        portList: pList,
        vendorCode: summary?.vendorCode ?? 0,
        unimoc: node.isUnimoc,
      }),
      ports: ports(regs, nodeId),
    };
  }

  // --- Registers -------------------------------------------------------------

  public scanRegisters(nodeId: number, pattern = '*'): Register[] {
    const node = this.simNodes.get(nodeId);
    if (!node) {
      throw new Error(`node ${nodeId} is offline`);
    }
    const all = Array.from(node.registers.values());
    if (pattern === '*' || !pattern.trim()) {
      return all;
    }
    const regexStr =
      '^' +
      pattern
        .trim()
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$';
    const re = new RegExp(regexStr, 'i');
    return all.filter((r) => re.test(r.name));
  }

  public readRegister(nodeId: number, name: string): Register {
    const node = this.simNodes.get(nodeId);
    if (!node) throw new Error(`node ${nodeId} is offline`);
    const reg = node.registers.get(name);
    if (!reg) {
      return {
        name,
        value: new RegisterValue('empty', null),
        mutable: false,
        persistent: false,
      };
    }
    return reg;
  }

  public writeRegister(nodeId: number, name: string, value: RegisterValue): WriteResult {
    const node = this.simNodes.get(nodeId);
    if (!node) throw new Error(`node ${nodeId} is offline`);
    const existing = node.registers.get(name);
    if (!existing) {
      return {
        accepted: false,
        register: { name, value: new RegisterValue('empty', null), mutable: false, persistent: false },
      };
    }
    if (!existing.mutable || existing.value.kind !== value.kind) {
      return { accepted: false, register: existing };
    }

    // Validate limits (matching UNIMOC firmware register validation)
    if (Array.isArray(value.content) && value.content.length > 0 && typeof value.content[0] === 'number') {
      const num = value.content[0];
      if (existing.min !== undefined && num < existing.min) {
        return { accepted: false, register: existing };
      }
      if (existing.max !== undefined && num > existing.max) {
        return { accepted: false, register: existing };
      }
      // Cross-register validation: v_dc_derate < v_dc_max and v_dc_min < v_dc_derate
      if (name === 'unimoc.power.v_dc_derate') {
        const vMax = (node.registers.get('unimoc.power.v_dc_max')?.value.content as number[])?.[0] ?? 58;
        const vMin = (node.registers.get('unimoc.power.v_dc_min')?.value.content as number[])?.[0] ?? 36;
        if (num >= vMax || num <= vMin) {
          return { accepted: false, register: existing };
        }
      }
      if (name === 'unimoc.power.v_dc_max') {
        const vDerate = (node.registers.get('unimoc.power.v_dc_derate')?.value.content as number[])?.[0] ?? 54;
        if (num <= vDerate) {
          return { accepted: false, register: existing };
        }
      }
      // Port ID range validation
      if (/^uavcan\.(pub|sub|srv|cln)\.[^.]+\.id$/.test(name)) {
        const maxSubject = name.startsWith('uavcan.srv.') || name.startsWith('uavcan.cln.') ? 511 : 8191;
        if (num > maxSubject && num !== READINESS_FOLLOWS_NODE_ID && num !== UNSET_PORT_ID) {
          return { accepted: false, register: existing };
        }
      }
    }

    const updated: Register = {
      ...existing,
      value,
    };
    node.registers.set(name, updated);

    if (existing.persistent) {
      const flashVal = node.flashRegisters.get(name);
      const differsFromFlash = flashVal ? !flashVal.sameAs(value) : true;
      if (differsFromFlash) {
        node.settingsPending = true;
        node.registers.set(
          'unimoc.settings.pending',
          makeReg('unimoc.settings.pending', 'bit', [true], false, false)
        );
      }
    }

    this.notify();
    return { accepted: true, register: updated };
  }

  public executeCommand(nodeId: number, command: number): number {
    const node = this.simNodes.get(nodeId);
    if (!node) throw new Error(`node ${nodeId} did not answer ExecuteCommand ${command}`);

    if (command === COMMANDS.store) {
      if (node.engaged || node.powerStage === PowerStage.ENABLED) {
        return 5; // BAD_STATE: store refused while power stage is enabled
      }
      for (const [k, reg] of node.registers.entries()) {
        if (reg.persistent) {
          node.flashRegisters.set(k, reg.value);
        }
      }
      node.settingsPending = false;
      node.registers.set(
        'unimoc.settings.pending',
        makeReg('unimoc.settings.pending', 'bit', [false], false, false)
      );
      this.emitLog(nodeId, 2, 'persistent settings stored to flash');
      this.notify();
      return 0;
    }

    if (command === COMMANDS['emergency-stop']) {
      node.engaged = false;
      this.engagedTargets.delete(nodeId);
      node.powerStage = PowerStage.DISABLED;
      node.emergencyStop = true;
      node.health = Health.CAUTION;
      this.emitLog(nodeId, 5, 'EMERGENCY_STOP latched; restart required to clear');
      this.notify();
      return 0;
    }

    if (command === COMMANDS.restart) {
      node.engaged = false;
      this.engagedTargets.delete(nodeId);
      node.powerStage = node.localControl ? PowerStage.ENABLED : PowerStage.DISABLED;
      node.emergencyStop = false;
      node.tripLatched = false;
      node.settingsPending = false;
      node.health = Health.NOMINAL;
      node.uptime = 1;
      // Restore non-stored persistent registers from flash
      for (const [k, flashVal] of node.flashRegisters.entries()) {
        const cur = node.registers.get(k);
        if (cur) {
          node.registers.set(k, { ...cur, value: flashVal });
        }
      }
      node.registers.set(
        'unimoc.settings.pending',
        makeReg('unimoc.settings.pending', 'bit', [false], false, false)
      );
      this.emitLog(nodeId, 2, 'node restarted (uptime reset to 1 s)');
      this.notify();
      return 0;
    }

    if (command === COMMANDS['factory-reset']) {
      if (node.engaged) return 5;
      const freshRegs = node.isUnimoc
        ? buildUnimocDriveRegisters(nodeId, node.defaultRole, node.wheelIndex, node.isSimulation)
        : buildGenericBmsRegisters(nodeId);
      node.registers.clear();
      node.flashRegisters.clear();
      for (const r of freshRegs) {
        node.registers.set(r.name, r);
        if (r.persistent) node.flashRegisters.set(r.name, r.value);
      }
      node.settingsPending = false;
      this.emitLog(nodeId, 2, 'factory defaults restored');
      this.notify();
      return 0;
    }

    return 3; // BAD_COMMAND
  }

  // --- Drive Control (Readiness, Setpoints, Stop, Recovery) ------------------

  public findTarget(nodeId: number): DriveTarget {
    const node = this.simNodes.get(nodeId);
    if (!node) throw new ControlError(`node ${nodeId} is offline`);
    const names = new Set(['uavcan.sub.readiness.id', ...SETPOINTS.map((s) => `uavcan.sub.${s}.id`)]);
    const subset = Array.from(node.registers.values()).filter((r) => names.has(r.name));
    const found = new Map<string, number>();
    for (const p of ports(subset, nodeId)) {
      if (p.kind === 'sub' && p.enabled && p.portId !== null) {
        found.set(p.name, p.portId);
      }
    }
    const readiness = found.get('readiness');
    if (readiness === undefined) {
      throw new ControlError(
        `node ${nodeId} has no readiness subscription; it cannot be enabled from the bus`
      );
    }
    const setpoints: Partial<Record<SetpointMode, number>> = {};
    for (const mode of Object.values(SetpointMode)) {
      const portId = found.get(mode);
      if (portId !== undefined) {
        setpoints[mode] = portId;
      }
    }
    return { nodeId, readiness, setpoints };
  }

  public foreignPublisher(subject: number): number | null {
    for (const n of this.nodes()) {
      const pList = this.portList(n.nodeId);
      if (pList && pList.publishers.has(subject)) {
        return n.nodeId;
      }
    }
    return null;
  }

  public engage(target: DriveTarget): void {
    const summary = this.nodes().find((n) => n.nodeId === target.nodeId);
    const simNode = this.simNodes.get(target.nodeId);
    if (!summary || !simNode) {
      throw new ControlError(`node ${target.nodeId} is offline`);
    }
    const status = summary.isUnimoc ? decodeVendorStatus(summary.vendorCode) : null;
    const refusals: Partial<Record<Chip, string>> = {
      [Chip.E_STOP]: 'the emergency stop is latched; recover it (restart) first',
      [Chip.TRIPPED]: 'a trip is latched; recover it (STANDBY) first',
      [Chip.FAULT]: 'the power stage reports a fault; recover it first',
      [Chip.BLOCKED]: 'the external enable is missing (E-stop loop open)',
      [Chip.LOCAL_CONTROL]: 'the drive is under local control (e-bike); it engages by itself',
    };
    for (const chip of summary.chips) {
      if (refusals[chip]) {
        throw new ControlError(`node ${target.nodeId}: ${refusals[chip]}`);
      }
    }
    if (status === null) {
      throw new ControlError(`node ${target.nodeId} is no UNIMOC drive`);
    }
    const other = this.foreignPublisher(target.readiness);
    if (other !== null) {
      throw new ControlError(
        `node ${other} publishes the readiness of node ${target.nodeId} (subject ${target.readiness}); cypilot does not take over from another master`
      );
    }

    this.knownTargets.set(target.nodeId, target);
    this.standbyTargets.delete(target.nodeId);
    this.watchdogTripped = false;
    this.feedWatchdog();
    this.engagedTargets.set(target.nodeId, target);
    simNode.engaged = true;
    simNode.powerStage = PowerStage.ENABLED;
    this.emitLog(target.nodeId, 2, `engaged on readiness subject ${target.readiness}`);
    this.notify();
  }

  public async disengage(nodeId: number, ramp = 0.5): Promise<void> {
    const target = this.engagedTargets.get(nodeId) ?? this.knownTargets.get(nodeId);
    const simNode = this.simNodes.get(nodeId);
    if (!target || !simNode) return;

    if (this.engagedTargets.has(nodeId)) {
      const mine: ActiveSetpoint[] = [];
      for (const sp of this.setpoints.values()) {
        if (target.setpoints[sp.mode] === sp.subject) {
          mine.push(sp);
        }
      }
      for (const sp of mine) {
        sp.target = sp.target.map(() => 0);
        sp.rampRemaining = Math.max(0, ramp);
        if (sp.rampRemaining === 0) sp.value = [...sp.target];
      }
      if (ramp > 0) {
        await new Promise((r) => setTimeout(r, Math.min(ramp * 1000, 1500)));
      }
      for (const sp of mine) {
        sp.value = [...sp.target];
        sp.rampRemaining = 0;
      }
    }

    this.engagedTargets.delete(nodeId);
    simNode.engaged = false;
    if (simNode.powerStage === PowerStage.ENABLED) {
      simNode.powerStage = PowerStage.DISABLED;
    }
    this.standbyTargets.set(nodeId, { target, untilMs: performance.now() + STANDBY_HOLD_MS });
    this.dropUnusedSetpoints();
    this.emitLog(nodeId, 2, 'disengaged (STANDBY hold 1.0 s)');
    this.notify();
  }

  public acknowledge(target: DriveTarget): void {
    const simNode = this.simNodes.get(target.nodeId);
    this.knownTargets.set(target.nodeId, target);
    this.engagedTargets.delete(target.nodeId);
    this.dropUnusedSetpoints();
    this.standbyTargets.set(target.nodeId, { target, untilMs: performance.now() + STANDBY_HOLD_MS });
    if (simNode) {
      simNode.engaged = false;
      // Clear trip if DC link voltage is back in bounds
      const vMax = (simNode.registers.get('unimoc.power.v_dc_max')?.value.content as number[])?.[0] ?? 58;
      const vMin = (simNode.registers.get('unimoc.power.v_dc_min')?.value.content as number[])?.[0] ?? 36;
      if (simNode.dcLinkV <= vMax && simNode.dcLinkV >= vMin) {
        simNode.tripLatched = false;
        if (simNode.powerStage === PowerStage.FAULT) {
          simNode.powerStage = PowerStage.DISABLED;
        }
        if (!simNode.emergencyStop) {
          simNode.health = Health.NOMINAL;
        }
      }
    }
    this.notify();
  }

  public stopAllImmediate(): number[] {
    const allTargets = new Map<number, DriveTarget>(this.knownTargets);
    for (const n of this.nodes()) {
      if (n.isUnimoc && !allTargets.has(n.nodeId)) {
        try {
          allTargets.set(n.nodeId, this.findTarget(n.nodeId));
        } catch {
          // ignore
        }
      }
    }
    this.engagedTargets.clear();
    this.standbyTargets.clear();
    for (const sp of this.setpoints.values()) {
      sp.value = sp.target.map(() => 0);
      sp.target = sp.target.map(() => 0);
      sp.rampRemaining = 0;
    }
    this.setpoints.clear();
    for (const nodeId of allTargets.keys()) {
      const simNode = this.simNodes.get(nodeId);
      if (simNode) {
        simNode.engaged = false;
        simNode.idCurrent = 0;
        simNode.iqCurrent = 0;
        simNode.torqueNm = 0;
        if (simNode.powerStage === PowerStage.ENABLED) {
          simNode.powerStage = PowerStage.DISABLED;
        }
      }
    }
    this.notify();
    return Array.from(allTargets.keys()).sort((a, b) => a - b);
  }

  public emergencyStopAll(nodeIds: number[]): Record<number, number | null> {
    this.stopAllImmediate();
    const results: Record<number, number | null> = {};
    for (const nodeId of nodeIds) {
      try {
        results[nodeId] = this.executeCommand(nodeId, COMMANDS['emergency-stop']);
      } catch {
        results[nodeId] = null;
      }
    }
    this.notify();
    return results;
  }

  public setSetpoint(target: DriveTarget, mode: SetpointMode, values: number[], ramp = 0.0): void {
    const expected = setpointComponents(mode);
    if (values.length !== expected) {
      throw new Error(`${mode} takes ${expected} value(s)`);
    }
    const subject = target.setpoints[mode];
    if (subject === undefined) {
      throw new ControlError(`node ${target.nodeId} does not subscribe a ${mode} setpoint`);
    }
    if (!this.engagedTargets.has(target.nodeId)) {
      throw new ControlError(`node ${target.nodeId} is not enabled`);
    }
    const key = `${mode}:${subject}`;
    let present = this.setpoints.get(key);
    if (!present) {
      present = {
        mode,
        subject,
        target: values.map(() => 0),
        value: values.map(() => 0),
        rampRemaining: 0,
      };
      this.setpoints.set(key, present);
    }
    present.target = [...values];
    present.rampRemaining = Math.max(0, ramp);
    if (present.rampRemaining === 0) {
      present.value = [...values];
    }
    this.notify();
  }

  public getActiveSetpoint(mode: SetpointMode, subject: number): ActiveSetpoint | null {
    return this.setpoints.get(`${mode}:${subject}`) ?? null;
  }

  private dropUnusedSetpoints(): void {
    const used = new Set<string>();
    for (const t of this.engagedTargets.values()) {
      for (const [m, subj] of Object.entries(t.setpoints)) {
        if (subj !== undefined) used.add(`${m}:${subj}`);
      }
    }
    for (const k of Array.from(this.setpoints.keys())) {
      if (!used.has(k)) this.setpoints.delete(k);
    }
  }

  public recoverNode(nodeId: number, options?: { allowRestart?: boolean }): Recovery {
    const steps: string[] = [];
    const summary = this.nodes().find((n) => n.nodeId === nodeId);
    if (!summary) {
      return { steps: ['offline: wait for the node to come back'], ready: false };
    }
    if (this.engagedTargets.has(nodeId)) {
      this.engagedTargets.delete(nodeId);
      const simNode = this.simNodes.get(nodeId);
      if (simNode) simNode.engaged = false;
      steps.push('disabled');
    }

    const chipSet = new Set(summary.chips);
    if (chipSet.has(Chip.E_STOP)) {
      if (!options?.allowRestart) {
        steps.push('the emergency stop is latched until a restart; confirm the restart');
        return { steps, ready: false };
      }
      this.executeCommand(nodeId, COMMANDS.restart);
      steps.push('restart sent');
      steps.push('the node restarted');
    } else if (chipSet.has(Chip.TRIPPED) || chipSet.has(Chip.FAULT)) {
      const target = this.findTarget(nodeId);
      this.acknowledge(target);
      steps.push('STANDBY sent (acknowledges the trip)');
      const afterTrip = this.nodes().find((n) => n.nodeId === nodeId);
      const afterChips = new Set(afterTrip?.chips ?? []);
      if (afterChips.has(Chip.TRIPPED) || afterChips.has(Chip.FAULT)) {
        steps.push('the trip or fault did not clear (check DC link voltage / fault source)');
        return { steps, ready: false };
      }
      steps.push('trip cleared');
    }

    const updated = this.nodes().find((n) => n.nodeId === nodeId);
    if (!updated) return { steps, ready: false };
    if (updated.chips.includes(Chip.BLOCKED)) {
      steps.push('the external enable is missing: check the E-stop loop (not possible from the bus)');
      return { steps, ready: false };
    }
    const blocking = updated.chips.filter((c) =>
      [Chip.E_STOP, Chip.TRIPPED, Chip.FAULT].includes(c)
    );
    const ready = blocking.length === 0;
    steps.push(ready ? 'ready to enable' : `still: ${blocking.join(', ')}`);
    return { steps, ready };
  }

  // --- Simulation Controls (unimoc.sim.*) ------------------------------------

  public simStatus(nodeId: number): SimStatus {
    const node = this.simNodes.get(nodeId);
    if (!node || !node.isSimulation) {
      throw new SimulationError(`node ${nodeId} is no UNIMOC simulation`);
    }
    return makeSimStatus(node.paused, node.cycleCount, node.cyclePeriodNs);
  }

  public simSetPaused(nodeId: number, paused: boolean): SimStatus {
    const node = this.simNodes.get(nodeId);
    if (!node || !node.isSimulation) {
      throw new SimulationError(`node ${nodeId} is no UNIMOC simulation`);
    }
    node.paused = paused;
    node.registers.set(SIM_PAUSED, makeReg(SIM_PAUSED, 'bit', [paused], true, false));
    this.notify();
    return this.simStatus(nodeId);
  }

  public simAdvance(nodeId: number, cycles: number): SimStatus {
    const node = this.simNodes.get(nodeId);
    if (!node || !node.isSimulation) {
      throw new SimulationError(`node ${nodeId} is no UNIMOC simulation`);
    }
    if (!node.paused) {
      throw new SimulationError('pause the simulation before advancing it');
    }
    if (cycles <= 0 || !Number.isInteger(cycles)) {
      throw new SimulationError('advance needs a positive integer number of control cycles');
    }
    node.cycleCount += cycles;
    node.registers.set(
      SIM_CYCLE_COUNT,
      makeReg(SIM_CYCLE_COUNT, 'natural64', [node.cycleCount], false, false)
    );
    // Record a telemetry sample at the new virtual cycle count
    const telSource = makeSource(node.nodeId, 'telemetry', 212, 'unimoc.drive.Telemetry.0.1');
    if (this.subscribedSources.has(telSource.key)) {
      this.liveRecorder.add(telSource, {
        control_cycles: node.cycleCount,
        engaged: node.engaged ? 1.0 : 0.0,
        i_d: node.idCurrent,
        i_q: node.iqCurrent,
        torque: node.torqueNm,
        speed: node.speedRadS,
        position: node.positionRad,
        v_dc: node.dcLinkV,
        fet_temp: node.fetTempC,
        overcurrent_tripped: node.tripLatched ? 1.0 : 0.0,
      });
    }
    this.notify();
    return this.simStatus(nodeId);
  }

  public simReset(nodeId: number): SimStatus {
    const node = this.simNodes.get(nodeId);
    if (!node || !node.isSimulation) {
      throw new SimulationError(`node ${nodeId} is no UNIMOC simulation`);
    }
    if (node.engaged) {
      throw new SimulationError(`node ${nodeId} refused unimoc.sim.reset = 1 (drive is enabled)`);
    }
    node.cycleCount = 0;
    node.idCurrent = 0;
    node.iqCurrent = 0;
    node.torqueNm = 0;
    node.speedRadS = 0;
    node.positionRad = 0;
    node.registers.set(SIM_CYCLE_COUNT, makeReg(SIM_CYCLE_COUNT, 'natural64', [0], false, false));
    this.notify();
    return this.simStatus(nodeId);
  }

  public simPlantInputRegisters(nodeId: number): Register[] {
    const node = this.simNodes.get(nodeId);
    if (!node || !node.isSimulation) return [];
    const controlSet = new Set([SIM_PAUSED, SIM_ADVANCE, SIM_RESET, SIM_CYCLE_COUNT, SIM_CYCLE_PERIOD]);
    return Array.from(node.registers.values()).filter(
      (r) => r.name.startsWith(SIM_PREFIX) && !controlSet.has(r.name) && r.mutable
    );
  }

  // --- Signal Sources & Subscriptions ----------------------------------------

  public nodeSources(nodeId: number): Source[] {
    const node = this.simNodes.get(nodeId);
    if (!node) return [];
    return discoverSources(node.registers.values(), nodeId);
  }

  public allSources(): Source[] {
    const out: Source[] = [];
    for (const id of Array.from(this.simNodes.keys()).sort((a, b) => a - b)) {
      out.push(...this.nodeSources(id));
    }
    return out;
  }

  public isSourceSubscribed(key: string): boolean {
    return this.subscribedSources.has(key);
  }

  public setSourceSubscribed(key: string, subscribed: boolean): void {
    if (subscribed) {
      this.subscribedSources.add(key);
      // Immediately seed a sample so fields appear right away
      const [nodeStr, portName] = key.split('/');
      const nodeId = Number(nodeStr);
      const node = this.simNodes.get(nodeId);
      const src = this.nodeSources(nodeId).find((s) => s.port === portName);
      if (node && src) {
        if (portName === 'telemetry') {
          this.liveRecorder.add(src, {
            control_cycles: node.cycleCount,
            engaged: node.engaged ? 1.0 : 0.0,
            i_d: node.idCurrent,
            i_q: node.iqCurrent,
            torque: node.torqueNm,
            speed: node.speedRadS,
            position: node.positionRad,
            v_dc: node.dcLinkV,
            fet_temp: node.fetTempC,
            overcurrent_tripped: node.tripLatched ? 1.0 : 0.0,
          });
        } else if (portName === 'drive_status') {
          this.liveRecorder.add(src, {
            engaged: node.engaged ? 1.0 : 0.0,
            speed: node.speedRadS,
            torque: node.torqueNm,
            v_dc: node.dcLinkV,
            motor_temp: node.motorTempC,
          });
        } else if (portName === 'battery_status') {
          this.liveRecorder.add(src, {
            pack_voltage: 48.2,
            pack_current: 0.0,
            soc_percent: 84.5,
            max_cell_temp: 27.2,
          });
        }
        this.emitStatus(`${key}: recording ${src.typeName}`, false);
      }
    } else {
      this.subscribedSources.delete(key);
    }
    this.notify();
  }

  public getSubscribedKeys(): string[] {
    return Array.from(this.subscribedSources).sort();
  }

  // --- CLI Command Interpreter (cypilot-ctl) ---------------------------------

  public executeCli(commandLine: string): { exitCode: number; output: string } {
    const tokens = tokenizeShell(commandLine.trim());
    if (tokens.length === 0) return { exitCode: 0, output: '' };
    if (tokens[0] === 'cypilot-ctl') tokens.shift();

    let jsonMode = false;
    const filtered: string[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === '--json') {
        jsonMode = true;
      } else if (tokens[i] === '-i' || tokens[i] === '--interface') {
        i++; // skip interface arg, uses current session
      } else {
        filtered.push(tokens[i]);
      }
    }

    if (filtered.length === 0 || filtered[0] === '--help' || filtered[0] === '-h') {
      return {
        exitCode: 0,
        output: [
          'usage: cypilot-ctl [--json] <command> [args...]',
          '',
          'commands:',
          '  nodes                              list the nodes of the bus with their state',
          '  regs <node> [pattern]              scan and print all registers of a node',
          '  get <node> <name>                  read one register',
          '  set <node> <name> <value>          write one register in its own type and check the answer',
          '  command <node> <cmd>               send ExecuteCommand (restart|store|factory-reset|emergency-stop)',
          '  caps <node>                        capabilities and ports of a node, found by discovery',
          '  profile save <node> <file>         save persistent registers of a node to JSON profile',
          '  profile diff <node> <file>         compare a node with a profile (exit 1 on differences)',
          '  profile load <node> <file> [opts]  write profile into a node (--dry-run, --store, --include-ports)',
          '  run <node> [--current ID,IQ]       enable a drive and set setpoint',
          '  stop                               SLEEP to every drive on the bus and zero setpoints at once',
          '  recover <node> [--restart]         clear a trip (STANDBY) or latched E-stop (--restart)',
          '  sim <node> <status|pause|run|advance|reset> [cycles]',
          '  record <node> [port] --out <name>  export recorded telemetry snapshot',
          '  dsdl                               show compiled UNIMOC DSDL source info',
        ].join('\n'),
      };
    }

    if (!this.isConnected && filtered[0] !== 'dsdl') {
      return { exitCode: 2, output: 'cypilot-ctl: not connected to a CAN interface' };
    }

    try {
      const sub = filtered[0];

      if (sub === 'dsdl') {
        const data = {
          source: 'unimoc v0.2.0',
          namespaces: ['uavcan', 'reg', 'unimoc', 'cymon'],
          compiled: '~/.cache/cypilot/dsdl/ref-v0.2.0/py',
        };
        return {
          exitCode: 0,
          output: jsonMode ? JSON.stringify(data, null, 2) : `${data.source}\n${data.compiled}`,
        };
      }

      if (sub === 'nodes') {
        const list = this.nodes();
        const data = list.map((n) => ({
          node_id: n.nodeId,
          name: n.name,
          health: Health[n.health],
          mode: Mode[n.mode],
          uptime: n.uptime,
          vendor_code: n.vendorCode,
          software_version: n.softwareVersion,
          vcs_revision: n.vcsRevision?.toString(16) ?? null,
          unique_id: n.uniqueIdHex,
          unimoc: n.unimoc,
          state: n.chips,
        }));
        const rows: string[][] = [
          ['ID', 'NAME', 'SW', 'HEALTH', 'MODE', 'UPTIME', 'STATE'],
          ...list.map((n) => [
            String(n.nodeId),
            n.name ?? '?',
            n.softwareVersion ? `${n.softwareVersion[0]}.${n.softwareVersion[1]}` : '?',
            Health[n.health],
            Mode[n.mode],
            `${n.uptime} s`,
            n.chips.join(', ') || '-',
          ]),
        ];
        return {
          exitCode: 0,
          output: jsonMode ? JSON.stringify(data, null, 2) : list.length ? formatCliTable(rows) : 'no nodes',
        };
      }

      if (sub === 'regs') {
        const nodeId = Number(filtered[1]);
        const pattern = filtered[2] ?? '*';
        const regs = this.scanRegisters(nodeId, pattern);
        const data = regs.map((r) => ({
          name: r.name,
          kind: r.value.kind,
          value: r.value.content instanceof Uint8Array ? r.value.format() : r.value.content,
          mutable: r.mutable,
          persistent: r.persistent,
        }));
        const rows: string[][] = [
          ['NAME', 'VALUE', 'TYPE', 'FLAGS'],
          ...regs.map((r) => [
            r.name,
            r.value.format(),
            formatRegisterType(r),
            (r.mutable ? 'm' : '-') + (r.persistent ? 'p' : '-'),
          ]),
        ];
        return {
          exitCode: 0,
          output: jsonMode ? JSON.stringify(data, null, 2) : formatCliTable(rows),
        };
      }

      if (sub === 'get') {
        const nodeId = Number(filtered[1]);
        const name = filtered[2];
        if (!name) return { exitCode: 2, output: 'cypilot-ctl: get requires <node> <name>' };
        const reg = this.readRegister(nodeId, name);
        if (reg.value.kind === 'empty') {
          return { exitCode: 1, output: `cypilot-ctl: node ${nodeId} has no register ${name}` };
        }
        const data = {
          name: reg.name,
          kind: reg.value.kind,
          value: reg.value.content,
          mutable: reg.mutable,
          persistent: reg.persistent,
        };
        return {
          exitCode: 0,
          output: jsonMode ? JSON.stringify(data, null, 2) : reg.value.format(),
        };
      }

      if (sub === 'set') {
        const nodeId = Number(filtered[1]);
        const name = filtered[2];
        const valText = filtered.slice(3).join(' ');
        if (!name || !valText) {
          return { exitCode: 2, output: 'cypilot-ctl: set requires <node> <name> <value>' };
        }
        const current = this.readRegister(nodeId, name);
        if (current.value.kind === 'empty') {
          return { exitCode: 2, output: `cypilot-ctl: node ${nodeId} has no register ${name}` };
        }
        if (!current.mutable) {
          return { exitCode: 2, output: `cypilot-ctl: ${name} is read-only` };
        }
        const parsed = parseLike(valText, current.value);
        const res = this.writeRegister(nodeId, name, parsed);
        const data = {
          name: res.register.name,
          kind: res.register.value.kind,
          value: res.register.value.content,
          mutable: res.register.mutable,
          persistent: res.register.persistent,
          accepted: res.accepted,
        };
        if (res.accepted) {
          this.emitStatus(`${name} = ${res.register.value.format()}`);
          return {
            exitCode: 0,
            output: jsonMode ? JSON.stringify(data, null, 2) : res.register.value.format(),
          };
        }
        this.emitStatus(`${name}: rejected, the node keeps ${res.register.value.format()}`);
        return {
          exitCode: 1,
          output: jsonMode
            ? JSON.stringify(data, null, 2)
            : `rejected, the value stays ${res.register.value.format()}`,
        };
      }

      if (sub === 'command') {
        const nodeId = Number(filtered[1]);
        const cmdName = filtered[2];
        if (!(cmdName in COMMANDS)) {
          return {
            exitCode: 2,
            output: `cypilot-ctl: unknown command ${JSON.stringify(cmdName)} (expected ${Object.keys(COMMANDS).join(', ')})`,
          };
        }
        const status = this.executeCommand(nodeId, COMMANDS[cmdName]);
        const text = COMMAND_STATUS[status] ?? `status ${status}`;
        const data = { command: cmdName, status, text };
        this.emitStatus(`node ${nodeId}: command ${cmdName} -> ${text}`);
        return {
          exitCode: status === 0 ? 0 : 1,
          output: jsonMode ? JSON.stringify(data, null, 2) : text,
        };
      }

      if (sub === 'caps') {
        const nodeId = Number(filtered[1]);
        const { capabilities: caps, ports: nodePorts } = this.nodeCapabilities(nodeId);
        const sortedCaps = caps.slice().sort();
        const rows: string[][] = [
          ['PORT', 'KIND', 'ID', 'TYPE'],
          ...nodePorts.map((p) => [
            p.name,
            p.kind,
            p.portId === null
              ? p.configured !== null
                ? 'off'
                : '?'
              : p.configured !== p.portId
                ? `${p.portId} (node-ID)`
                : String(p.portId),
            p.typeName ?? '?',
          ]),
        ];
        const data = {
          capabilities: sortedCaps,
          port_list: true,
          ports: nodePorts.map((p) => ({
            kind: p.kind,
            name: p.name,
            configured: p.configured,
            port_id: p.portId,
            type: p.typeName,
          })),
        };
        const text = `capabilities: ${sortedCaps.join(', ') || '-'}\n${formatCliTable(rows)}`;
        return {
          exitCode: 0,
          output: jsonMode ? JSON.stringify(data, null, 2) : text,
        };
      }

      if (sub === 'profile') {
        const action = filtered[1];
        const nodeId = Number(filtered[2]);
        const fileName = filtered[3] || 'profile.json';
        const regs = this.scanRegisters(nodeId);
        const summary = this.nodes().find((n) => n.nodeId === nodeId);

        if (action === 'save') {
          const prof = createProfileFromRegisters(regs, {
            nodeName: summary?.name ?? null,
            softwareVersion: summary?.softwareVersion ?? null,
            vcsRevision: summary?.vcsRevision ?? null,
          });
          this.savedProfiles.set(fileName, prof);
          this.notify();
          const count = Object.keys(prof.registers).length;
          const data = { file: fileName, registers: count };
          return {
            exitCode: 0,
            output: jsonMode ? JSON.stringify(data, null, 2) : `${count} registers saved to ${fileName}`,
          };
        }

        const prof = this.savedProfiles.get(fileName);
        if (!prof) {
          return {
            exitCode: 2,
            output: `cypilot-ctl: profile ${fileName} not found (available: ${Array.from(this.savedProfiles.keys()).join(', ')})`,
          };
        }

        if (action === 'diff') {
          const diffs = diffProfile(prof, regs);
          const data = diffs.map((d) => ({
            name: d.name,
            kind: d.kind,
            profile: d.profile ? d.profile.format() : null,
            node: d.node ? d.node.format() : null,
            skipped_on_load: d.skippedOnLoad,
          }));
          if (diffs.length === 0) {
            return { exitCode: 0, output: jsonMode ? '[]' : 'no differences' };
          }
          const rows: string[][] = [
            ['NAME', 'PROFILE', 'NODE', ''],
            ...diffs.map((d) => {
              let note = d.kind !== 'changed' ? d.kind : '';
              if (d.skippedOnLoad) note = `${note} skipped on load`.trim();
              return [d.name, d.profile ? d.profile.format() : '-', d.node ? d.node.format() : '-', note];
            }),
          ];
          return {
            exitCode: 1,
            output: jsonMode ? JSON.stringify(data, null, 2) : formatCliTable(rows),
          };
        }

        if (action === 'load') {
          const includePorts = filtered.includes('--include-ports');
          const includeIdentity = filtered.includes('--include-identity');
          const dryRun = filtered.includes('--dry-run');
          const doStore = filtered.includes('--store');
          const options = { includePorts, includeIdentity };

          if (dryRun) {
            const planned = diffProfile(prof, regs, options).filter(
              (d) => d.kind === 'changed' && !isSkippedOnLoad(d.name, options)
            );
            const wouldWrite: Record<string, string> = {};
            for (const d of planned) {
              if (d.profile) wouldWrite[d.name] = d.profile.format();
            }
            const data = { dry_run: true, would_write: wouldWrite };
            const lines = Object.entries(wouldWrite).map(([k, v]) => `${k} = ${v}`);
            return {
              exitCode: 0,
              output: jsonMode ? JSON.stringify(data, null, 2) : lines.join('\n') || 'nothing to write',
            };
          }

          const res = loadProfileSync(
            prof,
            regs,
            (name, val) => this.writeRegister(nodeId, name, val),
            options
          );
          const remaining = diffProfile(prof, this.scanRegisters(nodeId), options)
            .filter((d) => d.kind !== 'extra' && !isSkippedOnLoad(d.name, options))
            .map((d) => d.name);

          let storeStatus: number | null = null;
          if (doStore && res.complete && remaining.length === 0) {
            storeStatus = this.executeCommand(nodeId, COMMANDS.store);
          }

          const rejectedFormatted: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.rejected)) {
            rejectedFormatted[k] = v.format();
          }

          const data = {
            written: res.written,
            rejected: rejectedFormatted,
            skipped: res.skipped,
            missing: res.missing,
            incompatible: res.incompatible,
            still_different: remaining,
            store_status: storeStatus,
          };

          const lines = [`written: ${res.written.length}, skipped: ${res.skipped.length}`];
          for (const [k, v] of Object.entries(rejectedFormatted)) {
            lines.push(`rejected: ${k} stays ${v}`);
          }
          for (const m of res.missing) lines.push(`not on the node: ${m}`);
          for (const inc of res.incompatible) lines.push(`other type on the node: ${inc}`);
          for (const rem of remaining) lines.push(`still different: ${rem}`);
          if (storeStatus !== null) {
            lines.push(`store: ${COMMAND_STATUS[storeStatus] ?? String(storeStatus)}`);
          }

          const ok =
            Object.keys(res.rejected).length === 0 &&
            res.incompatible.length === 0 &&
            remaining.length === 0 &&
            (storeStatus === null || storeStatus === 0);
          return {
            exitCode: ok ? 0 : 1,
            output: jsonMode ? JSON.stringify(data, null, 2) : lines.join('\n'),
          };
        }
      }

      if (sub === 'stop') {
        const stopped = this.stopAllImmediate();
        this.emitStatus(`STOP ALL: SLEEP sent to ${stopped.join(', ') || 'no drive'}`);
        const data = { sleep_sent_to: stopped };
        return {
          exitCode: 0,
          output: jsonMode
            ? JSON.stringify(data, null, 2)
            : `SLEEP sent to ${stopped.join(', ') || 'no drive'}`,
        };
      }

      if (sub === 'recover') {
        const nodeId = Number(filtered[1]);
        const allowRestart = filtered.includes('--restart');
        const rec = this.recoverNode(nodeId, { allowRestart });
        this.emitStatus(`node ${nodeId}: ${rec.steps.join('; ')}`);
        const data = { steps: rec.steps, ready: rec.ready };
        return {
          exitCode: rec.ready ? 0 : 1,
          output: jsonMode ? JSON.stringify(data, null, 2) : rec.steps.join('\n'),
        };
      }

      if (sub === 'run') {
        const nodeId = Number(filtered[1]);
        const target = this.findTarget(nodeId);
        this.engage(target);
        const curIdx = filtered.indexOf('--current');
        if (curIdx !== -1 && filtered[curIdx + 1]) {
          const vals = filtered[curIdx + 1].split(',').map(Number);
          this.setSetpoint(target, SetpointMode.CURRENT, vals, 0.2);
        }
        const trqIdx = filtered.indexOf('--torque');
        if (trqIdx !== -1 && filtered[trqIdx + 1]) {
          this.setSetpoint(target, SetpointMode.TORQUE, [Number(filtered[trqIdx + 1])], 0.2);
        }
        const spdIdx = filtered.indexOf('--speed');
        if (spdIdx !== -1 && filtered[spdIdx + 1]) {
          this.setSetpoint(target, SetpointMode.SPEED, [Number(filtered[spdIdx + 1])], 0.2);
        }
        const summary = this.nodes().find((n) => n.nodeId === nodeId);
        const data = {
          node: nodeId,
          readiness: target.readiness,
          state: summary?.chips ?? [],
        };
        return {
          exitCode: 0,
          output: jsonMode
            ? JSON.stringify(data, null, 2)
            : `node ${nodeId} engaged on readiness ${target.readiness}; state: ${(summary?.chips ?? []).join(', ')}`,
        };
      }

      if (sub === 'sim') {
        const nodeId = Number(filtered[1]);
        const action = filtered[2];
        let status: SimStatus;
        if (action === 'pause') {
          status = this.simSetPaused(nodeId, true);
        } else if (action === 'run') {
          status = this.simSetPaused(nodeId, false);
        } else if (action === 'advance') {
          const cycles = Number(filtered[3] ?? 0);
          status = this.simAdvance(nodeId, cycles);
        } else if (action === 'reset') {
          status = this.simReset(nodeId);
        } else if (action === 'status') {
          status = this.simStatus(nodeId);
        } else {
          return {
            exitCode: 2,
            output: `cypilot-ctl: unknown sim action ${JSON.stringify(action)} (expected status, pause, run, advance, reset)`,
          };
        }
        const data = {
          paused: status.paused,
          cycle_count: status.cycleCount,
          cycle_period_ns: status.cyclePeriodNs,
          virtual_time: status.virtualTime,
        };
        const text = `${status.paused ? 'paused' : 'running'}, cycle ${status.cycleCount}, ${status.virtualTime.toFixed(4)} s`;
        return {
          exitCode: 0,
          output: jsonMode ? JSON.stringify(data, null, 2) : text,
        };
      }

      if (sub === 'record') {
        const outIdx = filtered.indexOf('--out');
        const outName = outIdx !== -1 && filtered[outIdx + 1] ? filtered[outIdx + 1] : 'rec';
        const snap = this.liveRecorder.exportSnapshot(outName);
        this.savedRecordings.push(snap);
        const counts: Record<string, number> = {};
        for (const key of this.liveRecorder.sourceKeys()) {
          counts[key] = this.liveRecorder.count(key);
        }
        const lines = Object.entries(counts).map(([k, c]) => `${k}: ${c} samples`);
        const data = { out: outName, samples: counts };
        this.notify();
        return {
          exitCode: 0,
          output: jsonMode ? JSON.stringify(data, null, 2) : lines.join('\n') || 'nothing received',
        };
      }

      return { exitCode: 2, output: `cypilot-ctl: unknown command ${JSON.stringify(sub)}` };
    } catch (err) {
      return {
        exitCode: 2,
        output: `cypilot-ctl: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // --- Cymon 16 kHz Triggered Scope & Expert Mode Functions ------------------

  public getCymonVariables(nodeId: number): CymonVariable[] {
    const node = this.simNodes.get(nodeId);
    if (!node || !node.isUnimoc) return [];
    return CYMON_DRIVE_VARIABLES;
  }

  public getCymonBufferInfo(nodeId: number): CymonBufferInfo | null {
    const node = this.simNodes.get(nodeId);
    if (!node || !node.isUnimoc) return null;
    const pubTrig = node.registers.get('uavcan.pub.cymon_trigger.id');
    const subj =
      pubTrig && Array.isArray(pubTrig.value.content) ? Number(pubTrig.value.content[0]) : null;
    return {
      ...DEFAULT_CYMON_BUFFER_INFO,
      sharedTriggerSubject: subj !== null && subj < 65535 ? subj : null,
    };
  }

  public checkSharedCymonTriggerSubject(nodeIds: number[]): {
    aligned: boolean;
    subjectId: number | null;
    details: Record<number, { pub: number | null; sub: number | null }>;
  } {
    const details: Record<number, { pub: number | null; sub: number | null }> = {};
    const subjects = new Set<number | null>();
    for (const id of nodeIds) {
      const n = this.simNodes.get(id);
      if (!n) continue;
      const pubReg = n.registers.get('uavcan.pub.cymon_trigger.id');
      const subReg = n.registers.get('uavcan.sub.cymon_trigger.id');
      const pubVal =
        pubReg && Array.isArray(pubReg.value.content) ? Number(pubReg.value.content[0]) : null;
      const subVal =
        subReg && Array.isArray(subReg.value.content) ? Number(subReg.value.content[0]) : null;
      const effPub = pubVal !== null && pubVal < 65535 ? pubVal : null;
      const effSub = subVal !== null && subVal < 65535 ? subVal : null;
      details[id] = { pub: effPub, sub: effSub };
      subjects.add(effPub);
      subjects.add(effSub);
    }
    const onlyVal = subjects.size === 1 ? Array.from(subjects)[0] : null;
    return {
      aligned: onlyVal !== null,
      subjectId: onlyVal,
      details,
    };
  }

  public configureSharedCymonTriggerSubject(nodeIds: number[], subjectId = 520): void {
    for (const id of nodeIds) {
      const n = this.simNodes.get(id);
      if (!n) continue;
      this.writeRegister(id, 'uavcan.pub.cymon_trigger.id', new RegisterValue('natural16', [subjectId]));
      this.writeRegister(id, 'uavcan.sub.cymon_trigger.id', new RegisterValue('natural16', [subjectId]));
      this.executeCommand(id, COMMANDS.store);
    }
    this.emitStatus(
      `cymon shared trigger subject ${subjectId} configured & stored on nodes ${nodeIds.join(', ')}`
    );
  }

  public captureCymonScopeShot(setup: CymonCaptureSetup): CymonCaptureShot {
    const nodeContext: Record<
      number,
      {
        name: string;
        iqBase: number;
        idBase: number;
        speedRadS: number;
        vDc: number;
        kp: number;
        ki: number;
      }
    > = {};

    for (const nodeId of setup.nodeIds) {
      const n = this.simNodes.get(nodeId);
      const desc = n?.registers.get('uavcan.node.description');
      const role = desc && typeof desc.value.content === 'string' ? desc.value.content : `node_${nodeId}`;
      const kpReg = n?.registers.get('unimoc.control.current_kp');
      const kiReg = n?.registers.get('unimoc.control.current_ki');
      nodeContext[nodeId] = {
        name: role,
        iqBase: n?.iqCurrent ?? 0,
        idBase: n?.idCurrent ?? 0,
        speedRadS: n?.speedRadS ?? 12.0,
        vDc: n?.dcLinkV ?? 48.0,
        kp: kpReg && Array.isArray(kpReg.value.content) ? Number(kpReg.value.content[0]) : 0.42,
        ki: kiReg && Array.isArray(kiReg.value.content) ? Number(kiReg.value.content[0]) : 240.0,
      };
    }

    const shot = synthesizeCymonCaptureShot(
      setup,
      nodeContext,
      this.spec?.mtu ?? 64
    );
    this.savedScopeShots = [shot, ...this.savedScopeShots.slice(0, 19)];

    this.emitLog(
      setup.triggerNodeId,
      2,
      `cymon scope capture complete: ${shot.traces.length} traces @ ${shot.effectiveSampleRateHz} Hz (${setup.sampleDepth} samples, edge=${setup.triggerEdge} on ${setup.triggerVariable})`
    );
    this.emitStatus(
      `cymon capture complete: ${setup.nodeIds.length} node(s), ${shot.traces.length} traces @ ${(shot.effectiveSampleRateHz / 1000).toFixed(1)} kHz (bus read ${shot.busTransferTimeSec}s)`
    );

    if (this.broadcastChannel) {
      try {
        this.broadcastChannel.postMessage({ type: 'scope_shot', shot });
      } catch {
        // ignore
      }
    }

    this.notify();
    return shot;
  }

  public publishRawSubject(subjectId: number, typeName: string, payloadJson: string): void {
    const nowSec = Date.now() / 1000;
    this.rawBusFrames.unshift({
      id: this.frameCounter++,
      timestamp: nowSec,
      direction: 'TX',
      kind: 'subject',
      portId: subjectId,
      nodeId: this.localNodeId,
      typeName,
      payload: payloadJson,
    });
    if (this.rawBusFrames.length > 200) this.rawBusFrames.pop();

    // Also feed into liveRecorder if payload has numeric fields
    try {
      const parsed = JSON.parse(payloadJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const numericFields: Record<string, number> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'number') numericFields[k] = v;
        }
        if (Object.keys(numericFields).length > 0) {
          const src = makeSource(this.localNodeId, `raw_${subjectId}`, subjectId, typeName);
          this.subscribedSources.add(src.key);
          this.liveRecorder.add(src, numericFields, nowSec);
        }
      }
    } catch {
      // ignore non-json
    }

    this.emitLog(
      this.localNodeId,
      1,
      `cymon raw TX subject ${subjectId} (${typeName}): ${payloadJson}`
    );
    this.emitStatus(`published raw subject ${subjectId} (${typeName})`);
  }

  public callRawService(
    targetNodeId: number,
    serviceId: number,
    typeName: string,
    requestJson: string
  ): { status: number; responseJson: string } {
    const nowSec = Date.now() / 1000;
    this.rawBusFrames.unshift({
      id: this.frameCounter++,
      timestamp: nowSec,
      direction: 'TX',
      kind: 'service',
      portId: serviceId,
      nodeId: targetNodeId,
      typeName,
      payload: requestJson,
    });

    let responseObj: Record<string, unknown> = { status: 0, node_id: targetNodeId };
    if (serviceId === 120 || typeName.includes('GetVariableList')) {
      responseObj = {
        variables: CYMON_DRIVE_VARIABLES.map((v) => ({
          index: v.index,
          name: v.name,
          unit: v.unit,
          type: v.type,
        })),
      };
    } else if (serviceId === 121 || typeName.includes('GetBufferInfo')) {
      responseObj = { ...DEFAULT_CYMON_BUFFER_INFO };
    } else if (serviceId === 435 || typeName.includes('ExecuteCommand')) {
      try {
        const req = JSON.parse(requestJson);
        const cmd = Number(req.command ?? 65530);
        const st = this.executeCommand(targetNodeId, cmd);
        responseObj = { status: st, status_text: COMMAND_STATUS[st] ?? 'unknown' };
      } catch {
        responseObj = { status: 4, status_text: 'bad parameter' };
      }
    }

    const responseJson = JSON.stringify(responseObj, null, 2);
    this.rawBusFrames.unshift({
      id: this.frameCounter++,
      timestamp: nowSec + 0.002,
      direction: 'RX',
      kind: 'service',
      portId: serviceId,
      nodeId: targetNodeId,
      typeName,
      payload: responseJson,
    });
    if (this.rawBusFrames.length > 200) this.rawBusFrames.length = 200;

    this.emitStatus(`service call ${serviceId} (${typeName}) -> node ${targetNodeId} answered`);
    return { status: 0, responseJson };
  }
}

function tokenizeShell(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        result.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) result.push(current);
  return result;
}

function formatCliTable(rows: string[][]): string {
  if (rows.length === 0) return '';
  const cols = rows[0].length;
  const widths = new Array<number>(cols).fill(0);
  for (const row of rows) {
    for (let c = 0; c < cols; c++) {
      widths[c] = Math.max(widths[c], (row[c] ?? '').length);
    }
  }
  return rows
    .map((row) =>
      row
        .map((cell, c) => (cell ?? '').padEnd(widths[c], ' '))
        .join('  ')
        .trimEnd()
    )
    .join('\n');
}

export { formatRegisterFlags, formatRegisterType, profileFromJson, profileToJson };
