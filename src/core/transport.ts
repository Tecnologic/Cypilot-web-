// SPDX-License-Identifier: Apache-2.0
/**
 * CAN interfaces as text, the same syntax as yakut's UAVCAN__CAN__IFACE.
 * Ported from src/cypilot/core/transport.py
 */

export const CLASSIC_MTU = 8;
export const FD_MTU = 64;
export const DEFAULT_BITRATE: [number, number] = [1_000_000, 1_000_000];
export const DEFAULT_LOCAL_NODE_ID = 127;

const CLASSIC_ONLY = new Set(['slcan']);
const VALID_MTUS = new Set([CLASSIC_MTU, 12, 16, 20, 24, 32, 48, FD_MTU]);

export class InterfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InterfaceError';
  }
}

export interface InterfaceSpec {
  readonly kind: string;
  readonly channel: string;
  readonly mtu: number;
  readonly bitrate: [number, number];
  readonly text: string;
  readonly isFd: boolean;
}

export function parseInterface(
  text: string,
  options?: { mtu?: number | null; bitrate?: [number, number] | null }
): InterfaceSpec {
  const trimmed = text.trim();
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx <= 0 || colonIdx === trimmed.length - 1) {
    throw new InterfaceError(`expected <interface>:<channel>, got ${JSON.stringify(text)}`);
  }
  const kind = trimmed.slice(0, colonIdx).toLowerCase();
  const channel = trimmed.slice(colonIdx + 1);
  const mtuOption = options?.mtu ?? null;

  let resolvedMtu: number;
  if (CLASSIC_ONLY.has(kind)) {
    if (mtuOption !== null && mtuOption !== CLASSIC_MTU) {
      throw new InterfaceError(`${kind} carries classic CAN only (MTU ${CLASSIC_MTU})`);
    }
    resolvedMtu = CLASSIC_MTU;
  } else {
    resolvedMtu = mtuOption === null ? FD_MTU : mtuOption;
  }

  if (!VALID_MTUS.has(resolvedMtu)) {
    throw new InterfaceError(`invalid CAN MTU ${resolvedMtu}`);
  }

  const resolvedBitrate: [number, number] = options?.bitrate ?? DEFAULT_BITRATE;
  if (Math.min(resolvedBitrate[0], resolvedBitrate[1]) <= 0) {
    throw new InterfaceError('bit rates must be positive');
  }

  return {
    kind,
    channel,
    mtu: resolvedMtu,
    bitrate: resolvedBitrate,
    text: `${kind}:${channel}`,
    isFd: resolvedMtu > CLASSIC_MTU,
  };
}

export function parseBitrateText(text: string): [number, number] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('/');
  const arb = Number.parseInt(parts[0], 10);
  const data = parts[1] ? Number.parseInt(parts[1], 10) : arb;
  if (Number.isNaN(arb) || Number.isNaN(data) || arb <= 0 || data <= 0) {
    throw new InterfaceError(`invalid bitrate format: ${JSON.stringify(text)} (expected ARB or ARB/DATA)`);
  }
  return [arb, data];
}

export function discoverInterfaces(): { text: string; description: string }[] {
  return [
    { text: 'socketcan:vcan0', description: 'Simulation cluster — 4 UNIMOC wheel drives + e-bike + BMS (CAN FD, MTU 64)' },
    { text: 'slcan:/dev/pts/1', description: 'Single simulated UNIMOC drive over pseudo-terminal (Classic CAN, MTU 8)' },
    { text: 'socketcan:can0', description: 'Bench CAN FD adapter with kernel driver (Node 10 + Dyno Node 11)' },
    { text: 'slcan:/dev/ttyACM0', description: 'CANable with slcan firmware on Linux (Classic CAN, MTU 8)' },
    { text: 'slcan:COM5', description: 'CANable with slcan firmware on Windows (Classic CAN, MTU 8)' },
    { text: 'pcan:PCAN_USBBUS1', description: 'PEAK PCAN-USB FD adapter via python-can (CAN FD, MTU 64)' },
    { text: 'gs_usb:0', description: 'candleLight / gs_usb adapter via python-can (CAN FD, MTU 64)' },
  ];
}
