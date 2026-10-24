// SPDX-License-Identifier: Apache-2.0
/**
 * Register profiles: the persistent settings of a node as a JSON file,
 * excluding node identity/unique registers, plus node-to-node settings transfer.
 * Ported from src/cypilot/core/profiles.py
 */

import { Register, RegisterKind, RegisterValue, WriteResult } from './registers';

export const PROFILE_FORMAT = 1;
const PORT_ID_RE = /^uavcan\.(pub|sub|srv|cln)\.[^.]+\.id$/;
export const IDENTITY_REGISTERS = new Set([
  'uavcan.node.id',
  'uavcan.node.description',
  'uavcan.node.unique_id',
]);
export const MAX_PASSES = 4;

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileError';
  }
}

export interface Profile {
  readonly registers: Record<string, RegisterValue>;
  readonly excludedUnique?: string[];
  readonly nodeName: string | null;
  readonly softwareVersion: [number, number] | null;
  readonly vcsRevision: number | null;
  readonly created: string;
}

export interface FilterUniqueOptions {
  includePorts?: boolean;
  includeIdentity?: boolean;
}

/**
 * Classifies whether a register is unique to a specific node instance
 * (node ID, description, hardware unique ID, or subject/service port ID).
 */
export function classifyUniqueRegister(name: string): {
  isUnique: boolean;
  category: 'identity' | 'port' | null;
  reason: string | null;
} {
  if (name === 'uavcan.node.id') {
    return { isUnique: true, category: 'identity', reason: 'Node CAN ID (unique per node)' };
  }
  if (name === 'uavcan.node.description') {
    return {
      isUnique: true,
      category: 'identity',
      reason: 'Node description / role name (unique per node)',
    };
  }
  if (name === 'uavcan.node.unique_id' || name.endsWith('.unique_id') || name.endsWith('.serial_number')) {
    return { isUnique: true, category: 'identity', reason: 'Hardware unique ID / serial' };
  }
  if (PORT_ID_RE.test(name)) {
    return {
      isUnique: true,
      category: 'port',
      reason: 'Per-node Cyphal subject/service port allocation',
    };
  }
  return { isUnique: false, category: null, reason: null };
}

export function isSkippedOnLoad(name: string, options?: FilterUniqueOptions): boolean {
  const info = classifyUniqueRegister(name);
  if (info.category === 'port') {
    return !options?.includePorts;
  }
  if (info.category === 'identity') {
    return !options?.includeIdentity;
  }
  return false;
}

export function valueToJson(value: RegisterValue): { kind: string; value: unknown } {
  const content = value.content;
  if (content instanceof Uint8Array) {
    const hex = Array.from(content)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return { kind: value.kind, value: hex };
  }
  return { kind: value.kind, value: content };
}

export function valueFromJson(data: Record<string, unknown>): RegisterValue {
  const kind = data.kind as RegisterKind;
  const content = data.value;
  if (kind === 'unstructured') {
    const str = String(content ?? '');
    const bytes = new Uint8Array(str.length / 2);
    for (let i = 0; i < str.length; i += 2) {
      bytes[i / 2] = Number.parseInt(str.slice(i, i + 2), 16);
    }
    return new RegisterValue(kind, bytes);
  }
  if (kind === 'string') {
    return new RegisterValue(kind, String(content ?? ''));
  }
  if (kind === 'empty') {
    return new RegisterValue(kind, null);
  }
  if (!Array.isArray(content)) {
    throw new Error(`${kind} needs a list of values`);
  }
  if (kind === 'bit') {
    return new RegisterValue(
      kind,
      content.map((item) => Boolean(item))
    );
  }
  if (kind.startsWith('real')) {
    return new RegisterValue(
      kind,
      content.map((item) => Number(item))
    );
  }
  return new RegisterValue(
    kind,
    content.map((item) => Math.trunc(Number(item)))
  );
}

export function createProfileFromRegisters(
  registers: Iterable<Register>,
  meta?: {
    nodeName?: string | null;
    softwareVersion?: [number, number] | null;
    vcsRevision?: number | null;
    includePorts?: boolean;
    includeIdentity?: boolean;
  }
): Profile {
  const map: Record<string, RegisterValue> = {};
  const excludedUnique: string[] = [];
  for (const r of registers) {
    if (r.mutable && r.persistent) {
      if (
        isSkippedOnLoad(r.name, {
          includePorts: meta?.includePorts ?? false,
          includeIdentity: meta?.includeIdentity ?? false,
        })
      ) {
        excludedUnique.push(r.name);
        continue;
      }
      map[r.name] = r.value;
    }
  }
  return {
    registers: map,
    excludedUnique: excludedUnique.sort(),
    nodeName: meta?.nodeName ?? null,
    softwareVersion: meta?.softwareVersion ?? null,
    vcsRevision: meta?.vcsRevision ?? null,
    created: new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00'),
  };
}

export function profileToJson(profile: Profile): string {
  const sortedRegisters: Record<string, unknown> = {};
  for (const name of Object.keys(profile.registers).sort()) {
    sortedRegisters[name] = valueToJson(profile.registers[name]);
  }
  const data = {
    format: PROFILE_FORMAT,
    node_name: profile.nodeName,
    software_version: profile.softwareVersion ? [...profile.softwareVersion] : null,
    vcs_revision: profile.vcsRevision !== null ? profile.vcsRevision.toString(16) : null,
    created: profile.created,
    excluded_unique_registers: profile.excludedUnique ?? [
      'uavcan.node.id',
      'uavcan.node.description',
      'uavcan.node.unique_id',
      'uavcan.(pub|sub|srv|cln).*.id',
    ],
    registers: sortedRegisters,
  };
  return JSON.stringify(data, null, 2) + '\n';
}

export function profileFromJson(text: string): Profile {
  try {
    const data = JSON.parse(text);
    if (
      typeof data !== 'object' ||
      data === null ||
      Array.isArray(data) ||
      data.format !== PROFILE_FORMAT
    ) {
      throw new ProfileError(`not a cypilot profile of format ${PROFILE_FORMAT}`);
    }
    if (typeof data.registers !== 'object' || data.registers === null) {
      throw new ProfileError('invalid profile: missing registers map');
    }
    const registers: Record<string, RegisterValue> = {};
    for (const [name, val] of Object.entries(data.registers)) {
      registers[name] = valueFromJson(val as Record<string, unknown>);
    }
    const version = Array.isArray(data.software_version)
      ? ([Number(data.software_version[0]), Number(data.software_version[1])] as [number, number])
      : null;
    const revision =
      typeof data.vcs_revision === 'string' && data.vcs_revision
        ? Number.parseInt(data.vcs_revision, 16)
        : null;
    const excludedUnique = Array.isArray(data.excluded_unique_registers)
      ? data.excluded_unique_registers.map(String)
      : undefined;
    return {
      registers,
      excludedUnique,
      nodeName: typeof data.node_name === 'string' ? data.node_name : null,
      softwareVersion: version,
      vcsRevision: revision,
      created: String(data.created ?? ''),
    };
  } catch (err) {
    if (err instanceof ProfileError) throw err;
    throw new ProfileError(
      `invalid profile: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export type DifferenceKind = 'changed' | 'type' | 'missing' | 'extra';

export interface Difference {
  readonly name: string;
  readonly profile: RegisterValue | null;
  readonly node: RegisterValue | null;
  readonly kind: DifferenceKind;
  readonly skippedOnLoad: boolean;
  readonly skipReason: string | null;
}

export function diffProfile(
  profile: Profile,
  registers: Iterable<Register>,
  options?: FilterUniqueOptions
): Difference[] {
  const nodeMap = new Map<string, RegisterValue>();
  for (const r of registers) {
    if (r.mutable && r.persistent) {
      nodeMap.set(r.name, r.value);
    }
  }
  const allNames = new Set<string>([...Object.keys(profile.registers), ...nodeMap.keys()]);
  const sortedNames = Array.from(allNames).sort();
  const result: Difference[] = [];

  for (const name of sortedNames) {
    const wanted = profile.registers[name] ?? null;
    const actual = nodeMap.get(name) ?? null;
    const skipped = isSkippedOnLoad(name, options);
    const uniqueInfo = classifyUniqueRegister(name);

    // If a unique register was excluded when saving the profile, don't clutter diff with "extra"
    if (wanted === null && skipped) {
      continue;
    }

    if (wanted !== null && actual !== null && wanted.sameAs(actual)) {
      continue;
    }
    let kind: DifferenceKind;
    if (actual === null) {
      kind = 'missing';
    } else if (wanted === null) {
      kind = 'extra';
    } else if (wanted.kind !== actual.kind) {
      kind = 'type';
    } else {
      kind = 'changed';
    }
    result.push({
      name,
      profile: wanted,
      node: actual,
      kind,
      skippedOnLoad: skipped,
      skipReason: skipped ? uniqueInfo.reason : null,
    });
  }
  return result;
}

export interface LoadResult {
  written: string[];
  rejected: Record<string, RegisterValue>;
  skipped: string[];
  missing: string[];
  incompatible: string[];
  complete: boolean;
}

export function loadProfileSync(
  profile: Profile,
  registers: Iterable<Register>,
  writeFn: (name: string, value: RegisterValue) => WriteResult,
  options?: FilterUniqueOptions
): LoadResult {
  const written: string[] = [];
  let rejected: Record<string, RegisterValue> = {};
  const skipped: string[] = [];
  const missing: string[] = [];
  const incompatible: string[] = [];

  // Record any registers on the node or profile that were skipped due to uniqueness rules
  const seenSkipped = new Set<string>();
  for (const r of registers) {
    if (r.mutable && r.persistent && isSkippedOnLoad(r.name, options)) {
      seenSkipped.add(r.name);
    }
  }

  let pending = new Map<string, RegisterValue>();
  for (const d of diffProfile(profile, registers, options)) {
    if (d.kind === 'extra') continue;
    if (isSkippedOnLoad(d.name, options)) {
      seenSkipped.add(d.name);
    } else if (d.kind === 'missing') {
      missing.push(d.name);
    } else if (d.kind === 'type') {
      incompatible.push(d.name);
    } else if (d.profile !== null) {
      pending.set(d.name, d.profile);
    }
  }
  skipped.push(...Array.from(seenSkipped).sort());

  for (let attempt = 0; attempt < MAX_PASSES; attempt++) {
    const refused = new Map<string, RegisterValue>();
    const kept: Record<string, RegisterValue> = {};
    for (const [name, value] of pending.entries()) {
      const outcome = writeFn(name, value);
      if (outcome.accepted) {
        written.push(name);
      } else {
        refused.set(name, value);
        kept[name] = outcome.register.value;
      }
    }
    if (refused.size === 0) break;
    if (refused.size === pending.size || attempt === MAX_PASSES - 1) {
      rejected = kept;
      break;
    }
    pending = refused;
  }

  return {
    written,
    rejected,
    skipped,
    missing,
    incompatible,
    complete: Object.keys(rejected).length === 0 && incompatible.length === 0,
  };
}
