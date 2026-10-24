// SPDX-License-Identifier: Apache-2.0
/**
 * What a node supports, found by discovery instead of a node type.
 * Ported from src/cypilot/core/capabilities.py
 */

import { Register } from './registers';
import { decodeVendorStatus } from './status';

export const UNSET_PORT_ID = 65535;
export const READINESS_FOLLOWS_NODE_ID = 65534;
export const READINESS_BASE = 1024;

export const EXECUTE_COMMAND_SERVICE = 435;
export const REGISTER_LIST_SERVICE = 385;
export const DIAGNOSTIC_RECORD_SUBJECT = 8184;

export const SETPOINTS = [
  'current_setpoint',
  'torque_setpoint',
  'speed_setpoint',
  'position_setpoint',
  'servo_setpoint',
] as const;

export const CYMON_SERVICES = [
  'cymon_variables',
  'cymon_buffer_info',
  'cymon_setup',
  'cymon_arm',
  'cymon_read',
] as const;

const PORT_REGISTER_RE = /^uavcan\.(pub|sub|srv|cln)\.([^.]+)\.(id|type)$/;

export enum Capability {
  REGISTERS = 'registers',
  COMMANDS = 'commands',
  ARMABLE = 'armable',
  SETPOINTS = 'setpoints',
  CART = 'cart drive',
  SCOPE = 'scope',
  SIMULATION = 'simulation',
  LOCAL_CONTROL = 'local control',
  LOG = 'log',
}

export interface Port {
  readonly kind: string; // 'pub' | 'sub' | 'srv' | 'cln'
  readonly name: string;
  readonly configured: number | null;
  readonly portId: number | null;
  readonly typeName: string | null;
  readonly enabled: boolean;
}

export interface PortList {
  readonly publishers: ReadonlySet<number>;
  readonly subscribers: ReadonlySet<number>;
  readonly servers: ReadonlySet<number>;
}

function effectivePortId(
  kind: string,
  name: string,
  configured: number | null,
  nodeId: number | null
): number | null {
  if (configured === null || configured === UNSET_PORT_ID) {
    return null;
  }
  if (kind === 'sub' && name === 'readiness' && configured === READINESS_FOLLOWS_NODE_ID) {
    return nodeId !== null && nodeId >= 0 && nodeId <= 127 ? READINESS_BASE + nodeId : null;
  }
  return configured;
}

export function ports(registers: Iterable<Register>, nodeId: number | null): Port[] {
  const ids = new Map<string, number | null>();
  const types = new Map<string, string>();
  const keys = new Map<string, [string, string]>();

  for (const register of registers) {
    const match = PORT_REGISTER_RE.exec(register.name);
    if (!match) continue;
    const [, kind, name, field] = match;
    const mapKey = `${kind}:${name}`;
    keys.set(mapKey, [kind, name]);
    const content = register.value.content;
    if (field === 'type' && typeof content === 'string') {
      types.set(mapKey, content);
    } else if (field === 'id') {
      ids.set(mapKey, Array.isArray(content) && content.length > 0 ? Number(content[0]) : null);
    }
  }

  const sortedKeys = Array.from(keys.keys()).sort();
  return sortedKeys.map((mapKey) => {
    const [kind, name] = keys.get(mapKey)!;
    const configured = ids.get(mapKey) ?? null;
    const portId = effectivePortId(kind, name, configured, nodeId);
    const typeName = types.get(mapKey) ?? null;
    return {
      kind,
      name,
      configured,
      portId,
      typeName,
      enabled: portId !== null,
    };
  });
}

export function capabilities(
  registers: Iterable<Register>,
  nodeId: number | null,
  options?: {
    portList?: PortList | null;
    vendorCode?: number | null;
    unimoc?: boolean;
  }
): Capability[] {
  const regList = Array.from(registers);
  const enabledPorts = new Map<string, Port>();
  for (const p of ports(regList, nodeId)) {
    if (p.enabled) {
      enabledPorts.set(p.name, p);
    }
  }

  const result = new Set<Capability>();
  const portList = options?.portList ?? null;

  if (regList.length > 0 || (portList !== null && portList.servers.has(REGISTER_LIST_SERVICE))) {
    result.add(Capability.REGISTERS);
  }
  if (portList !== null) {
    if (portList.servers.has(EXECUTE_COMMAND_SERVICE)) {
      result.add(Capability.COMMANDS);
    }
    if (portList.publishers.has(DIAGNOSTIC_RECORD_SUBJECT)) {
      result.add(Capability.LOG);
    }
  }
  if (enabledPorts.has('readiness')) {
    result.add(Capability.ARMABLE);
  }
  if (SETPOINTS.some((name) => enabledPorts.has(name))) {
    result.add(Capability.SETPOINTS);
  }
  if (enabledPorts.has('wheel_command')) {
    result.add(Capability.CART);
  }
  if (CYMON_SERVICES.every((name) => enabledPorts.has(name))) {
    result.add(Capability.SCOPE);
  }
  if (regList.some((r) => r.name.startsWith('unimoc.sim.'))) {
    result.add(Capability.SIMULATION);
  }
  if (
    options?.unimoc &&
    options.vendorCode !== null &&
    options.vendorCode !== undefined &&
    decodeVendorStatus(options.vendorCode).localControl
  ) {
    result.add(Capability.LOCAL_CONTROL);
  }
  return Array.from(result);
}

export function setpointPorts(registers: Iterable<Register>, nodeId: number | null): Port[] {
  const enabledSub = new Map<string, Port>();
  for (const p of ports(registers, nodeId)) {
    if (p.kind === 'sub' && p.enabled) {
      enabledSub.set(p.name, p);
    }
  }
  return SETPOINTS.filter((name) => enabledSub.has(name)).map((name) => enabledSub.get(name)!);
}
