// SPDX-License-Identifier: Apache-2.0
/**
 * Cymon 16 kHz Triggered Scope Capture & Expert Protocol Engine.
 * Implements section 8.2 of docs/plan.md:
 * - cymon.GetVariableList.0.1 (srv.cymon_variables)
 * - cymon.GetBufferInfo.0.1 (srv.cymon_buffer_info)
 * - cymon.SetupCapture.0.1 (srv.cymon_setup)
 * - cymon.ArmTrigger.0.1 (srv.cymon_arm)
 * - cymon.ReadBuffer.0.1 (srv.cymon_read)
 * - cymon.TriggerEvent.0.1 (pub/sub.cymon_trigger shared multi-node trigger)
 */

export type CymonTriggerEdge = 'rising' | 'falling' | 'hysteresis' | 'immediate';

export type CymonMultiNodeSyncMode = 'shared_trigger_event' | 'per_node_signal';

export type CymonCaptureState =
  | 'IDLE'
  | 'ARMED'
  | 'PRE_TRIGGER'
  | 'WAITING_TRIGGER'
  | 'READING_FRAMES'
  | 'COMPLETE';

export interface CymonVariable {
  readonly index: number;
  readonly name: string;
  readonly unit: string;
  readonly type: 'float32' | 'int32' | 'uint16';
  readonly description: string;
}

export interface CymonBufferInfo {
  readonly maxChannels: number; // 8
  readonly maxSamples: number; // 1024
  readonly tickPeriodNs: number; // 62500 ns (16 kHz)
  readonly sharedTriggerSubject: number | null;
}

export interface CymonCaptureSetup {
  readonly nodeIds: number[];
  readonly channelsByNode: Record<number, string[]>; // max 8 per node
  readonly sampleDepth: number; // e.g. 256, 512, 1024
  readonly decimation: number; // 1 (16 kHz), 2 (8 kHz), 4 (4 kHz), 8 (2 kHz), 16 (1 kHz)
  readonly preTriggerPercent: number; // 0..90
  readonly triggerNodeId: number;
  readonly triggerVariable: string;
  readonly triggerEdge: CymonTriggerEdge;
  readonly triggerLevel: number;
  readonly triggerHysteresis: number;
  readonly syncMode: CymonMultiNodeSyncMode;
  readonly injectTestStepOnArm: boolean;
  readonly testStepAmplitude: number;
}

export interface CymonCapturedTrace {
  readonly nodeId: number;
  readonly nodeName: string;
  readonly variable: string;
  readonly unit: string;
  readonly timeMs: number[]; // relative to trigger sample t = 0.000 ms
  readonly values: number[];
  readonly triggerDelayMs: number; // 0 for trigger node or per_node_signal; ~1.1..1.8 ms for shared_trigger_event follower
}

export interface CymonCaptureShot {
  readonly id: string;
  readonly createdIso: string;
  readonly setup: CymonCaptureSetup;
  readonly effectiveSampleRateHz: number;
  readonly samplePeriodUs: number;
  readonly triggerSampleIndex: number;
  readonly busTransferTimeSec: number;
  readonly uncertaintyBandMs: [number, number] | null;
  readonly traces: CymonCapturedTrace[];
}

export const CYMON_DRIVE_VARIABLES: CymonVariable[] = [
  {
    index: 0,
    name: 'foc.i_q',
    unit: 'A',
    type: 'float32',
    description: 'Measured quadrature-axis torque current at 16 kHz',
  },
  {
    index: 1,
    name: 'foc.i_q_ref',
    unit: 'A',
    type: 'float32',
    description: 'Quadrature-axis current loop reference command',
  },
  {
    index: 2,
    name: 'foc.i_d',
    unit: 'A',
    type: 'float32',
    description: 'Measured direct-axis flux current at 16 kHz',
  },
  {
    index: 3,
    name: 'foc.i_d_ref',
    unit: 'A',
    type: 'float32',
    description: 'Direct-axis current loop reference command',
  },
  {
    index: 4,
    name: 'foc.v_q',
    unit: 'V',
    type: 'float32',
    description: 'PI controller quadrature voltage output',
  },
  {
    index: 5,
    name: 'foc.v_d',
    unit: 'V',
    type: 'float32',
    description: 'PI controller direct voltage output',
  },
  {
    index: 6,
    name: 'foc.omega_mech',
    unit: 'rad/s',
    type: 'float32',
    description: 'Observer mechanical rotor angular velocity',
  },
  {
    index: 7,
    name: 'foc.theta_el',
    unit: 'rad',
    type: 'float32',
    description: 'Electrical rotor angle (0 .. 2π)',
  },
  {
    index: 8,
    name: 'power.v_dc',
    unit: 'V',
    type: 'float32',
    description: 'DC-link capacitor voltage sampled at PWM center',
  },
  {
    index: 9,
    name: 'pwm.duty_a',
    unit: '',
    type: 'float32',
    description: 'Phase A SVM PWM duty cycle (0.0 .. 1.0)',
  },
  {
    index: 10,
    name: 'pwm.duty_b',
    unit: '',
    type: 'float32',
    description: 'Phase B SVM PWM duty cycle (0.0 .. 1.0)',
  },
  {
    index: 11,
    name: 'pwm.duty_c',
    unit: '',
    type: 'float32',
    description: 'Phase C SVM PWM duty cycle (0.0 .. 1.0)',
  },
];

export const DEFAULT_CYMON_BUFFER_INFO: CymonBufferInfo = {
  maxChannels: 8,
  maxSamples: 1024,
  tickPeriodNs: 62500, // 16 kHz
  sharedTriggerSubject: 520,
};

/**
 * Synthesizes a realistic 16 kHz FOC control-loop capture across one or more UNIMOC drives,
 * modeling second-order RL + PI current loop dynamics, SVM switching ripple, and multi-node
 * cymon.TriggerEvent bus propagation delay (~1.25 ms on follower nodes).
 */
export function synthesizeCymonCaptureShot(
  setup: CymonCaptureSetup,
  nodeContext: Record<
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
  >,
  mtuBytes = 64
): CymonCaptureShot {
  const tickPeriodSec = (DEFAULT_CYMON_BUFFER_INFO.tickPeriodNs * setup.decimation) / 1e9;
  const effectiveSampleRateHz = Math.round(1 / tickPeriodSec);
  const samplePeriodUs = Number((tickPeriodSec * 1e6).toFixed(2));
  const depth = Math.max(64, Math.min(1024, setup.sampleDepth));
  const triggerSampleIndex = Math.floor((depth * setup.preTriggerPercent) / 100);

  const traces: CymonCapturedTrace[] = [];
  let maxFollowerDelayMs = 0;
  let minFollowerDelayMs = 999;

  for (const nodeId of setup.nodeIds) {
    const ctx = nodeContext[nodeId] ?? {
      name: `node_${nodeId}`,
      iqBase: 0,
      idBase: 0,
      speedRadS: 12.0,
      vDc: 48.0,
      kp: 0.42,
      ki: 120.0,
    };
    const isTriggerNode = nodeId === setup.triggerNodeId;
    // Shared cymon.TriggerEvent over Cyphal wakes thread within 1..2 ms (section 8.2)
    const triggerDelayMs =
      isTriggerNode || setup.syncMode === 'per_node_signal'
        ? 0.0
        : Number((1.15 + ((nodeId % 5) * 0.14)).toFixed(3));

    if (triggerDelayMs > 0) {
      maxFollowerDelayMs = Math.max(maxFollowerDelayMs, triggerDelayMs);
      minFollowerDelayMs = Math.min(minFollowerDelayMs, triggerDelayMs);
    }

    const stepAmp = setup.injectTestStepOnArm
      ? setup.testStepAmplitude
      : Math.max(2.5, Math.abs(setup.triggerLevel) * 1.35 || 4.0);
    const preIq = Math.abs(ctx.iqBase) > 0.2 ? ctx.iqBase * 0.3 : 0.4;
    const postIq = setup.triggerEdge === 'falling' ? -stepAmp : preIq + stepAmp;

    // Underdamped / critically damped FOC current loop response parameters
    const naturalFreqRad = 2 * Math.PI * (680 + (ctx.kp - 0.42) * 350);
    const damping = Math.max(0.48, Math.min(0.95, 0.72 - (ctx.kp - 0.42) * 0.25));

    const timeMs: number[] = [];
    for (let i = 0; i < depth; i++) {
      const relSamples = i - triggerSampleIndex;
      timeMs.push(Number((relSamples * tickPeriodSec * 1000).toFixed(4)));
    }

    const selectedVars = setup.channelsByNode[nodeId] ?? ['foc.i_q', 'foc.i_q_ref'];
    for (const varName of selectedVars.slice(0, 8)) {
      const varMeta = CYMON_DRIVE_VARIABLES.find((v) => v.name === varName);
      const values: number[] = [];

      for (let i = 0; i < depth; i++) {
        const tRelSec = (i - triggerSampleIndex) * tickPeriodSec - triggerDelayMs / 1000;
        const ripple =
          0.045 * Math.sin(2 * Math.PI * 16000 * i * tickPeriodSec + nodeId) +
          0.02 * Math.cos(2 * Math.PI * 5333 * i * tickPeriodSec);

        let val = 0;
        if (varName === 'foc.i_q_ref') {
          val = tRelSec >= 0 ? postIq : preIq;
        } else if (varName === 'foc.i_q') {
          if (tRelSec < 0) {
            val = preIq + ripple;
          } else {
            const wd = naturalFreqRad * Math.sqrt(Math.max(0.01, 1 - damping * damping));
            const env = Math.exp(-damping * naturalFreqRad * tRelSec);
            const stepResp =
              1 -
              env *
                (Math.cos(wd * tRelSec) +
                  (damping / Math.sqrt(Math.max(0.01, 1 - damping * damping))) *
                    Math.sin(wd * tRelSec));
            val = preIq + (postIq - preIq) * stepResp + ripple;
          }
        } else if (varName === 'foc.i_d_ref') {
          val = 0.0;
        } else if (varName === 'foc.i_d') {
          const crossCoupling =
            tRelSec >= 0 ? -0.18 * (postIq - preIq) * Math.exp(-2200 * tRelSec) : 0;
          val = ctx.idBase + crossCoupling + ripple * 0.7;
        } else if (varName === 'foc.v_q') {
          const spike =
            tRelSec >= 0 && tRelSec < 0.0015
              ? (postIq - preIq) * ctx.kp * 4.5 * Math.exp(-1800 * tRelSec)
              : 0;
          val = 3.2 + (tRelSec >= 0 ? postIq : preIq) * 0.45 + spike + ripple * 1.8;
        } else if (varName === 'foc.v_d') {
          val = -0.35 * (tRelSec >= 0 ? postIq : preIq) + ripple * 1.2;
        } else if (varName === 'foc.omega_mech') {
          const accel = tRelSec >= 0 ? ((postIq * 1.4) / 0.025) * tRelSec : 0;
          val = ctx.speedRadS + accel + ripple * 0.15;
        } else if (varName === 'foc.theta_el') {
          const omegaEl = Math.max(15, (ctx.speedRadS || 12) * 15);
          val = ((i * tickPeriodSec * omegaEl) % (2 * Math.PI));
        } else if (varName === 'power.v_dc') {
          const sag =
            tRelSec >= 0 ? -0.065 * Math.abs(postIq) * (1 - Math.exp(-900 * tRelSec)) : 0;
          val = ctx.vDc + sag + ripple * 0.4;
        } else if (varName.startsWith('pwm.duty_')) {
          const phaseShift =
            varName === 'pwm.duty_a' ? 0 : varName === 'pwm.duty_b' ? (2 * Math.PI) / 3 : (4 * Math.PI) / 3;
          const mod = tRelSec >= 0 ? 0.38 : 0.14;
          val = 0.5 + mod * Math.sin(2 * Math.PI * 240 * i * tickPeriodSec + phaseShift);
        }

        values.push(Number(val.toFixed(5)));
      }

      traces.push({
        nodeId,
        nodeName: ctx.name,
        variable: varName,
        unit: varMeta?.unit ?? '',
        timeMs,
        values,
        triggerDelayMs,
      });
    }
  }

  // Compute realistic bus transfer duration (section 8.2: 8x1024 is ~0.4s per node on CAN FD, 8x longer on classic CAN)
  const totalSamples = traces.reduce((acc, t) => acc + t.values.length, 0);
  const fdFactor = mtuBytes >= 64 ? 1.0 : 7.8;
  const busTransferTimeSec = Number(((totalSamples / (8 * 1024)) * 0.4 * fdFactor).toFixed(2));

  const uncertaintyBandMs: [number, number] | null =
    setup.nodeIds.length > 1 && setup.syncMode === 'shared_trigger_event' && maxFollowerDelayMs > 0
      ? [minFollowerDelayMs, maxFollowerDelayMs]
      : null;

  return {
    id: `shot_${Date.now()}`,
    createdIso: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    setup,
    effectiveSampleRateHz,
    samplePeriodUs,
    triggerSampleIndex,
    busTransferTimeSec,
    uncertaintyBandMs,
    traces,
  };
}
