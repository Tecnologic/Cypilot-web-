// SPDX-License-Identifier: Apache-2.0
/**
 * The simulation controls of a UNIMOC native_sim drive (registers unimoc.sim.*).
 * Ported from src/cypilot/core/sim_control.py
 */

import { Register } from './registers';

export const SIM_PREFIX = 'unimoc.sim.';
export const SIM_PAUSED = SIM_PREFIX + 'paused';
export const SIM_ADVANCE = SIM_PREFIX + 'advance';
export const SIM_RESET = SIM_PREFIX + 'reset';
export const SIM_CYCLE_COUNT = SIM_PREFIX + 'cycle_count';
export const SIM_CYCLE_PERIOD = SIM_PREFIX + 'cycle_period_ns';
export const MAX_ADVANCE = 16000;

export const CONTROL_REGISTERS = new Set([
  SIM_PAUSED,
  SIM_ADVANCE,
  SIM_RESET,
  SIM_CYCLE_COUNT,
  SIM_CYCLE_PERIOD,
]);

export class SimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimulationError';
  }
}

export interface SimStatus {
  readonly paused: boolean;
  readonly cycleCount: number;
  readonly cyclePeriodNs: number;
  readonly virtualTime: number;
}

export function makeSimStatus(paused: boolean, cycleCount: number, cyclePeriodNs: number): SimStatus {
  return {
    paused,
    cycleCount,
    cyclePeriodNs,
    virtualTime: cycleCount * cyclePeriodNs * 1e-9,
  };
}

export function isSimulation(registers: Iterable<Register>): boolean {
  for (const r of registers) {
    if (r.name === SIM_PAUSED) return true;
  }
  return false;
}

export function chunks(cycles: number): number[] {
  if (cycles < 0 || !Number.isInteger(cycles)) {
    throw new Error('cycles must be a non-negative integer');
  }
  const full = Math.floor(cycles / MAX_ADVANCE);
  const rest = cycles % MAX_ADVANCE;
  const result = new Array<number>(full).fill(MAX_ADVANCE);
  if (rest > 0) result.push(rest);
  return result;
}
