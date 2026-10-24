// SPDX-License-Identifier: Apache-2.0
/**
 * Live signals of any node: subjects as named numeric channels, a recorder, export and replay (G4).
 * Ported from src/cypilot/core/signals.py
 */

import { ports } from './capabilities';
import { Register } from './registers';

export const DEFAULT_HISTORY = 600.0;
export const EXPORT_FORMAT = 1;

export class SignalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalError';
  }
}

export interface Source {
  readonly nodeId: number;
  readonly port: string;
  readonly subject: number;
  readonly typeName: string;
  readonly key: string;
}

export function makeSource(nodeId: number, port: string, subject: number, typeName: string): Source {
  return {
    nodeId,
    port,
    subject,
    typeName,
    key: `${nodeId}/${port}`,
  };
}

export function discoverSources(registers: Iterable<Register>, nodeId: number): Source[] {
  return ports(registers, nodeId)
    .filter((p) => p.kind === 'pub' && p.portId !== null && Boolean(p.typeName))
    .map((p) => makeSource(nodeId, p.name, p.portId!, p.typeName!));
}

export interface Trace {
  source: Source;
  times: number[];
  rows: Record<string, number>[];
}

export function traceFields(trace: Trace): string[] {
  const seen = new Set<string>();
  const slice = trace.rows.slice(-50);
  for (const row of slice) {
    for (const k of Object.keys(row)) {
      seen.add(k);
    }
  }
  return Array.from(seen);
}

export interface RecordingSnapshot {
  name: string;
  createdAt: string;
  meta: {
    format: number;
    sources: {
      file: string;
      node_id: number;
      port: string;
      subject: number;
      type: string;
    }[];
    markers: { time: number; text: string }[];
  };
  csvFiles: Record<string, string>;
}

export class Recorder {
  readonly history: number;
  private traces = new Map<string, Trace>();
  public markers: [number, string][] = [];

  constructor(history: number = DEFAULT_HISTORY) {
    this.history = history;
  }

  add(source: Source, row: Record<string, number>, stamp?: number): void {
    const now = stamp ?? Date.now() / 1000;
    let trace = this.traces.get(source.key);
    if (!trace) {
      trace = { source, times: [], rows: [] };
      this.traces.set(source.key, trace);
    }
    trace.times.push(now);
    trace.rows.push(row);
    while (trace.times.length > 0 && trace.times[0] < now - this.history) {
      trace.times.shift();
      trace.rows.shift();
    }
  }

  mark(text: string, stamp?: number): void {
    const now = stamp ?? Date.now() / 1000;
    this.markers.push([now, text]);
    while (this.markers.length > 0 && this.markers[0][0] < now - this.history) {
      this.markers.shift();
    }
  }

  sourceKeys(): string[] {
    return Array.from(this.traces.keys()).sort();
  }

  source(key: string): Source | null {
    return this.traces.get(key)?.source ?? null;
  }

  count(key: string): number {
    return this.traces.get(key)?.times.length ?? 0;
  }

  firstTime(key: string): number | null {
    const t = this.traces.get(key);
    return t && t.times.length > 0 ? t.times[0] : null;
  }

  lastTime(key: string): number | null {
    const t = this.traces.get(key);
    return t && t.times.length > 0 ? t.times[t.times.length - 1] : null;
  }

  fields(key: string): string[] {
    const t = this.traces.get(key);
    return t ? traceFields(t) : [];
  }

  series(key: string, name: string, since?: number | null): [number[], number[]] {
    const trace = this.traces.get(key);
    if (!trace) return [[], []];
    const times: number[] = [];
    const values: number[] = [];
    for (let i = 0; i < trace.times.length; i++) {
      const t = trace.times[i];
      if (since !== null && since !== undefined && t < since) continue;
      times.push(t);
      const val = trace.rows[i][name];
      values.push(val === undefined ? Number.NaN : val);
    }
    return [times, values];
  }

  clear(): void {
    this.traces.clear();
    this.markers = [];
  }

  exportSnapshot(name = `recording_${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`): RecordingSnapshot {
    const csvFiles: Record<string, string> = {};
    const metaSources: RecordingSnapshot['meta']['sources'] = [];

    for (const trace of this.traces.values()) {
      const { source } = trace;
      const fileName = `node${source.nodeId}_${source.port}.csv`;
      const cols = traceFields(trace);
      const lines: string[] = [['time', ...cols].join(',')];
      for (let i = 0; i < trace.times.length; i++) {
        const stamp = trace.times[i].toFixed(6);
        const cells = cols.map((c) => {
          const v = trace.rows[i][c];
          return v === undefined || Number.isNaN(v) ? '' : String(Number(v.toFixed(6)));
        });
        lines.push([stamp, ...cells].join(','));
      }
      csvFiles[fileName] = lines.join('\n') + '\n';
      metaSources.push({
        file: fileName,
        node_id: source.nodeId,
        port: source.port,
        subject: source.subject,
        type: source.typeName,
      });
    }

    const meta = {
      format: EXPORT_FORMAT,
      sources: metaSources,
      markers: this.markers.map(([time, text]) => ({ time, text })),
    };

    return {
      name,
      createdAt: new Date().toLocaleTimeString(),
      meta,
      csvFiles,
    };
  }

  static fromSnapshot(snapshot: RecordingSnapshot): Recorder {
    if (snapshot.meta.format !== EXPORT_FORMAT) {
      throw new SignalError(`unknown recording format ${snapshot.meta.format}`);
    }
    const recorder = new Recorder(Number.POSITIVE_INFINITY);
    for (const entry of snapshot.meta.sources) {
      const source = makeSource(entry.node_id, entry.port, entry.subject, entry.type);
      const csvText = snapshot.csvFiles[entry.file];
      if (!csvText) continue;
      const lines = csvText.trim().split(/\r?\n/);
      if (lines.length === 0) continue;
      const headers = lines[0].split(',');
      if (headers[0] !== 'time') {
        throw new SignalError('a recording CSV starts with a time column');
      }
      for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const cells = lines[i].split(',');
        const stamp = Number(cells[0]);
        const row: Record<string, number> = {};
        for (let c = 1; c < headers.length; c++) {
          row[headers[c]] = cells[c] === '' || cells[c] === undefined ? Number.NaN : Number(cells[c]);
        }
        recorder.add(source, row, stamp);
      }
    }
    for (const marker of snapshot.meta.markers) {
      recorder.mark(marker.text, marker.time);
    }
    return recorder;
  }
}
