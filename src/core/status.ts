// SPDX-License-Identifier: Apache-2.0
/**
 * Node status from the Cyphal heartbeat.
 * Ported from src/cypilot/core/status.py
 *
 * Bits  Meaning
 * 0..2  power stage: 0 disabled, 1 enabled, 2 fault, 3 blocked
 * 3     engaged
 * 4     trip latched (overcurrent or overvoltage), cleared by STANDBY
 * 5     emergency stop latched, cleared by a restart
 * 6     settings pending (wait for the disengage)
 * 7     local control: the node engages by itself (e-bike)
 */

export enum Health {
  NOMINAL = 0,
  ADVISORY = 1,
  CAUTION = 2,
  WARNING = 3,
}

export function healthName(h: Health): string {
  switch (h) {
    case Health.NOMINAL:
      return 'nominal';
    case Health.ADVISORY:
      return 'advisory';
    case Health.CAUTION:
      return 'caution';
    case Health.WARNING:
      return 'warning';
  }
}

export enum Mode {
  OPERATIONAL = 0,
  INITIALIZATION = 1,
  MAINTENANCE = 2,
  SOFTWARE_UPDATE = 3,
}

export function modeName(m: Mode): string {
  switch (m) {
    case Mode.OPERATIONAL:
      return 'operational';
    case Mode.INITIALIZATION:
      return 'initialization';
    case Mode.MAINTENANCE:
      return 'maintenance';
    case Mode.SOFTWARE_UPDATE:
      return 'software_update';
  }
}

export enum PowerStage {
  DISABLED = 0,
  ENABLED = 1,
  FAULT = 2,
  BLOCKED = 3,
  UNKNOWN = 7,
}

export enum Chip {
  OFFLINE = 'offline',
  E_STOP = 'E-stop latched',
  TRIPPED = 'tripped',
  FAULT = 'fault',
  BLOCKED = 'blocked',
  ENGAGED = 'engaged',
  ENABLED = 'enabled',
  DISABLED = 'disabled',
  SETTINGS_PENDING = 'settings pending',
  LOCAL_CONTROL = 'local control',
}

export const CHIP_COLORS: Record<Chip, string> = {
  [Chip.OFFLINE]: '#9e9e9e',
  [Chip.E_STOP]: '#c62828',
  [Chip.TRIPPED]: '#e65100',
  [Chip.FAULT]: '#e65100',
  [Chip.BLOCKED]: '#ef6c00',
  [Chip.ENGAGED]: '#2e7d32',
  [Chip.ENABLED]: '#558b2f',
  [Chip.DISABLED]: '#546e7a',
  [Chip.SETTINGS_PENDING]: '#1565c0',
  [Chip.LOCAL_CONTROL]: '#6a1b9a',
};

export const HEALTH_COLORS: Partial<Record<Health, string>> = {
  [Health.ADVISORY]: '#ef6c00',
  [Health.CAUTION]: '#c62828',
  [Health.WARNING]: '#b71c1c',
};

export interface VendorStatus {
  readonly powerStage: PowerStage;
  readonly engaged: boolean;
  readonly tripLatched: boolean;
  readonly emergencyStop: boolean;
  readonly settingsPending: boolean;
  readonly localControl: boolean;
}

export function decodeVendorStatus(code: number): VendorStatus {
  if (code < 0 || code > 0xff || !Number.isInteger(code)) {
    throw new Error(`vendor status code out of range: ${code}`);
  }
  const stage = code & 0x07;
  return {
    powerStage: stage <= PowerStage.BLOCKED ? (stage as PowerStage) : PowerStage.UNKNOWN,
    engaged: Boolean(code & 0x08),
    tripLatched: Boolean(code & 0x10),
    emergencyStop: Boolean(code & 0x20),
    settingsPending: Boolean(code & 0x40),
    localControl: Boolean(code & 0x80),
  };
}

export function encodeVendorStatus(status: VendorStatus): number {
  let code = status.powerStage & 0x07;
  if (status.engaged) code |= 0x08;
  if (status.tripLatched) code |= 0x10;
  if (status.emergencyStop) code |= 0x20;
  if (status.settingsPending) code |= 0x40;
  if (status.localControl) code |= 0x80;
  return code;
}

export function computeChips(params: {
  online: boolean;
  health: Health;
  vendorCode: number;
  unimoc: boolean;
}): Chip[] {
  const { online, health, vendorCode, unimoc } = params;
  if (!online) {
    return [Chip.OFFLINE];
  }
  if (!unimoc) {
    return [];
  }
  const status = decodeVendorStatus(vendorCode);
  const result: Chip[] = [];
  if (status.emergencyStop || health === Health.CAUTION) {
    result.push(Chip.E_STOP);
  }
  if (status.tripLatched) {
    result.push(Chip.TRIPPED);
  }
  if (status.powerStage === PowerStage.FAULT) {
    result.push(Chip.FAULT);
  }
  if (status.powerStage === PowerStage.BLOCKED) {
    result.push(Chip.BLOCKED);
  }
  if (status.engaged) {
    result.push(Chip.ENGAGED);
  } else if (status.powerStage === PowerStage.ENABLED) {
    result.push(Chip.ENABLED);
  } else if (status.powerStage === PowerStage.DISABLED && result.length === 0) {
    result.push(Chip.DISABLED);
  }
  if (status.settingsPending) {
    result.push(Chip.SETTINGS_PENDING);
  }
  if (status.localControl) {
    result.push(Chip.LOCAL_CONTROL);
  }
  return result;
}

export function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const rest = seconds % 3600;
  const minutes = Math.floor(rest / 60);
  const secs = rest % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}
