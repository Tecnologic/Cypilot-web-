// SPDX-License-Identifier: Apache-2.0
/**
 * Cyphal registers: scanned from the node, never from a fixed list.
 * Ported from src/cypilot/core/registers.py
 */

export type Scalar = number | boolean;
export type Content = Scalar[] | string | Uint8Array | null;

export const ARRAY_KINDS = [
  'bit',
  'integer64',
  'integer32',
  'integer16',
  'integer8',
  'natural64',
  'natural32',
  'natural16',
  'natural8',
  'real64',
  'real32',
  'real16',
] as const;

export const KINDS = ['empty', 'string', 'unstructured', ...ARRAY_KINDS] as const;
export type RegisterKind = (typeof KINDS)[number];

export class RegisterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegisterError';
  }
}

function roundForKind(kind: RegisterKind, item: Scalar): Scalar {
  if (typeof item === 'boolean') return item;
  if (kind === 'real32' || kind === 'real16') {
    return Math.fround(item);
  }
  return item;
}

function formatScalar(kind: RegisterKind, item: Scalar): string {
  if (kind === 'bit') {
    return item ? '1' : '0';
  }
  const num = Number(item);
  if (kind === 'real32' || kind === 'real16') {
    if (!Number.isFinite(num)) return String(num);
    return Number(num.toPrecision(7)).toString();
  }
  return String(num);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/\s+/g, '');
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(clean)) {
    throw new Error(`expected hex bytes, got ${JSON.stringify(hex)}`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = Number.parseInt(clean.slice(i, i + 2), 16);
  }
  return out;
}

export class RegisterValue {
  readonly kind: RegisterKind;
  readonly content: Content;

  constructor(kind: RegisterKind, content: Content) {
    if (!KINDS.includes(kind)) {
      throw new Error(`unknown register value kind ${JSON.stringify(kind)}`);
    }
    this.kind = kind;
    this.content = content;
  }

  format(): string {
    if (this.kind === 'empty' || this.content === null) {
      return '';
    }
    if (typeof this.content === 'string') {
      return this.content;
    }
    if (this.content instanceof Uint8Array) {
      return bytesToHex(this.content);
    }
    return this.content.map((item) => formatScalar(this.kind, item)).join(', ');
  }

  sameAs(other: RegisterValue): boolean {
    if (this.kind !== other.kind) return false;
    if (this.content instanceof Uint8Array && other.content instanceof Uint8Array) {
      return bytesToHex(this.content) === bytesToHex(other.content);
    }
    if (!Array.isArray(this.content) || !Array.isArray(other.content)) {
      return this.content === other.content;
    }
    if (this.content.length !== other.content.length) return false;
    return this.content.every((a, idx) => {
      const b = (other.content as Scalar[])[idx];
      if (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b)) {
        return true;
      }
      return roundForKind(this.kind, a) === roundForKind(this.kind, b);
    });
  }
}

export interface Register {
  readonly name: string;
  readonly value: RegisterValue;
  readonly mutable: boolean;
  readonly persistent: boolean;
  readonly unit?: string;
  readonly description?: string;
  readonly min?: number;
  readonly max?: number;
}

export interface WriteResult {
  readonly accepted: boolean;
  readonly register: Register;
}

function parseScalar(kind: RegisterKind, text: string): Scalar {
  const trimmed = text.trim();
  if (kind === 'bit') {
    const lowered = trimmed.toLowerCase();
    if (['1', 'true', 'on', 'yes'].includes(lowered)) return true;
    if (['0', 'false', 'off', 'no'].includes(lowered)) return false;
    throw new Error(`expected a bit (1/0, true/false, on/off), got ${JSON.stringify(text)}`);
  }
  if (kind.startsWith('real')) {
    const num = Number(trimmed);
    if (Number.isNaN(num)) {
      throw new Error(`expected a floating-point number, got ${JSON.stringify(text)}`);
    }
    return num;
  }
  if (!/^[+-]?(0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|\d+)$/.test(trimmed)) {
    throw new Error(`expected an integer for ${kind}, got ${JSON.stringify(text)}`);
  }
  const number = Number(trimmed);
  const bits = Number.parseInt(kind.replace(/^integer|^natural/, ''), 10);
  const [low, high] = kind.startsWith('integer')
    ? [-(2 ** (bits - 1)), 2 ** (bits - 1) - 1]
    : [0, 2 ** bits - 1];
  if (number < low || number > high) {
    throw new Error(`${number} is out of the range of ${kind} (${low} to ${high})`);
  }
  return number;
}

export function parseLike(text: string, template: RegisterValue): RegisterValue {
  const kind = template.kind;
  if (kind === 'string') {
    return new RegisterValue(kind, text);
  }
  if (kind === 'unstructured') {
    return new RegisterValue(kind, hexToBytes(text));
  }
  if (kind === 'empty') {
    throw new Error('the register is empty and takes no value');
  }
  const items = text.split(',').map((item) => item.trim());
  const expected = Array.isArray(template.content) ? template.content.length : items.length;
  if (items.length !== expected) {
    throw new Error(`expected ${expected} value(s), got ${items.length}`);
  }
  return new RegisterValue(
    kind,
    items.map((item) => parseScalar(kind, item))
  );
}

export function formatRegisterType(register: Register): string {
  const { content, kind } = register.value;
  return Array.isArray(content) ? `${kind}[${content.length}]` : kind;
}

export function formatRegisterFlags(register: Register): string {
  const parts: string[] = [];
  if (register.mutable) parts.push('mutable');
  if (register.persistent) parts.push('persistent');
  return parts.join(' ');
}
