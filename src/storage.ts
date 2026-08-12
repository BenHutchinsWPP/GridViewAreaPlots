// src/storage.ts
//
// Save / load of the processed cubes, main-thread side. The actual OPFS I/O
// runs in storage-worker.ts because `createSyncAccessHandle` is worker-only.
//
// The manifest carries BOTH the retained column list and the full source
// column list. Without the source list a saved bundle looks like a study
// that never had emissions data, when in fact the user just did not keep
// those columns -- and the UI needs to offer a re-ingest for the second case
// and not the first.
//
// Presence and TOU bitmaps ride in the manifest as base64. They are small
// (2 KB and 8.8 KB per case) and keeping them out of the binary section
// means the cube bytes stay a plain concatenation of Float32Array dumps.

import { HOURS_PER_YEAR } from './calendar';
import { allAreas, exportGroupings } from './groupings';
import type { CaseData } from './types';
import type { StorageRequest, StorageResponse } from './storage-worker';

interface ManifestCase {
  name: string;
  year: number;
  /** The cube's metric axis, in index order. */
  metrics: string[];
  /** Every column the source CSV carried, retained or not. */
  sourceColumns: string[];
  areas: string[];
  presence: string;
  tou: string;
  cubeBytes: number;
}

interface Manifest {
  version: 1;
  cases: ManifestCase[];
  /** The area -> grouping mapping in effect when this bundle was written, as
   * a Groupings.csv. Optional: bundles written before the mapping became
   * editable at runtime do not carry one, and still load. */
  groupings?: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

let worker: Worker | null = null;

function storageWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./storage-worker.ts', import.meta.url), { type: 'module' });
  }
  return worker;
}

/** Pre-warm at page load, for the same reason the parse pool is pre-warmed
 * (D10): worker startup is ~40 ms, and on a Load it lands entirely inside
 * the measured reload-from-cache window. */
export function warmStorage(): void {
  storageWorker();
}

function request(message: StorageRequest, transfer: Transferable[] = []): Promise<StorageResponse> {
  const target = storageWorker();
  return new Promise((resolve, reject) => {
    const handler = (event: MessageEvent<StorageResponse>) => {
      target.removeEventListener('message', handler);
      if (event.data.kind === 'error') reject(new Error(event.data.message));
      else resolve(event.data);
    };
    target.addEventListener('message', handler);
    target.postMessage(message, transfer);
  });
}

function buildManifest(cases: CaseData[]): Manifest {
  return {
    version: 1,
    groupings: exportGroupings(),
    cases: cases.map((data) => ({
      name: data.name,
      year: data.year,
      metrics: data.metrics,
      sourceColumns: data.sourceColumns,
      areas: data.areas,
      presence: toBase64(data.presence),
      tou: toBase64(data.tou),
      cubeBytes: data.cube.byteLength,
    })),
  };
}

function cubeBytes(data: CaseData): Uint8Array<ArrayBuffer> {
  return new Uint8Array(data.cube.buffer as ArrayBuffer, data.cube.byteOffset, data.cube.byteLength);
}

export async function saveBundle(
  cases: CaseData[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const manifest = buildManifest(cases);

  await request({ kind: 'saveBegin', manifest: JSON.stringify(manifest) });
  for (let i = 0; i < cases.length; i++) {
    // Cloned, not transferred: transferring would detach the live cube the
    // app is still rendering from. One case at a time bounds the transient
    // copy at ~75 MB instead of the whole working set.
    await request({ kind: 'saveChunk', bytes: cubeBytes(cases[i]) });
    onProgress?.(i + 1, cases.length);
  }
  await request({ kind: 'saveEnd' });
}

// ---------------------------------------------------------------- disk file
//
// The .gvap file is the same manifest and the same cube bytes as the OPFS
// bundle, in one stream: "GVAP" | uint32 manifest length | manifest JSON |
// cube bytes, concatenated in manifest order. It is written through a
// FileSystemWritableFileStream where the browser has one, so a multi-case
// study never needs a second full copy of itself in memory to be saved.

const MAGIC = 'GVAP';

/** Chrome/Edge expose showSaveFilePicker; nothing else does yet. */
interface SavePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle>;
}

/** True when the user cancelled the file dialog rather than hitting an error. */
export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export async function downloadBundle(
  cases: CaseData[],
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const manifest = new TextEncoder().encode(JSON.stringify(buildManifest(cases)));
  const header = new Uint8Array(MAGIC.length + 4);
  header.set(new TextEncoder().encode(MAGIC));
  new DataView(header.buffer).setUint32(MAGIC.length, manifest.byteLength, true);

  const suggestedName = `gridview-${cases.length}-case${cases.length === 1 ? '' : 's'}.gvap`;
  const picker = (window as SavePickerWindow).showSaveFilePicker;

  if (picker) {
    const handle = await picker.call(window, {
      suggestedName,
      types: [{ description: 'GridView Area Plots bundle', accept: { 'application/octet-stream': ['.gvap'] } }],
    });
    const stream = await handle.createWritable();
    await stream.write(header);
    await stream.write(manifest);
    for (let i = 0; i < cases.length; i++) {
      await stream.write(cubeBytes(cases[i]));
      onProgress?.(i + 1, cases.length);
    }
    await stream.close();
    return handle.name;
  }

  // Fallback: one Blob and an anchor click. The Blob references the cube
  // buffers rather than copying them up front, but the browser still has to
  // materialise the file, so this path costs the study's size on disk.
  const blob = new Blob([header, manifest, ...cases.map(cubeBytes)], {
    type: 'application/octet-stream',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = suggestedName;
  anchor.click();
  // Revoked on the next task: revoking synchronously races the download.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  onProgress?.(cases.length, cases.length);
  return suggestedName;
}

/** True for a file that is a saved bundle rather than a CSV export. */
export async function isBundleFile(file: File): Promise<boolean> {
  const head = await file.slice(0, MAGIC.length).text();
  return head === MAGIC;
}

export async function readBundleFile(file: File): Promise<RestoredBundle> {
  const headerBytes = new Uint8Array(await file.slice(0, MAGIC.length + 4).arrayBuffer());
  if (new TextDecoder().decode(headerBytes.subarray(0, MAGIC.length)) !== MAGIC) {
    throw new Error(`${file.name} is not a GridView bundle.`);
  }
  const manifestLength = new DataView(headerBytes.buffer).getUint32(MAGIC.length, true);
  const start = MAGIC.length + 4;
  const manifest = JSON.parse(
    await file.slice(start, start + manifestLength).text(),
  ) as Manifest;

  let offset = start + manifestLength;
  const cubes: ArrayBuffer[] = [];
  for (const entry of manifest.cases) {
    cubes.push(await file.slice(offset, offset + entry.cubeBytes).arrayBuffer());
    offset += entry.cubeBytes;
  }
  return restore(manifest, cubes);
}

export interface RestoredBundle {
  cases: CaseData[];
  /** The mapping the bundle was saved under, or null for older bundles. */
  groupings: string | null;
}

export async function loadBundle(): Promise<RestoredBundle> {
  const response = await request({ kind: 'load' });
  if (response.kind !== 'loaded') throw new Error('unexpected storage reply');
  return restore(JSON.parse(response.manifest) as Manifest, response.cubes);
}

function restore(manifest: Manifest, cubes: ArrayBuffer[]): RestoredBundle {
  return { cases: casesFromManifest(manifest, cubes), groupings: manifest.groupings ?? null };
}

function casesFromManifest(manifest: Manifest, cubes: ArrayBuffer[]): CaseData[] {
  if (manifest.version !== 1) {
    throw new Error(`Saved bundle is version ${manifest.version}; this build reads version 1.`);
  }

  return manifest.cases.map((entry, index) => {
    const cube = new Float32Array(cubes[index]);
    const expected = entry.areas.length * entry.metrics.length * HOURS_PER_YEAR;
    if (cube.length !== expected) {
      throw new Error(
        `Saved cube for "${entry.name}" is ${cube.length} values, expected ${expected} ` +
          `(${entry.areas.length} areas × ${entry.metrics.length} metrics × ${HOURS_PER_YEAR} h).`,
      );
    }
    return {
      name: entry.name,
      cube,
      areas: entry.areas.length > 0 ? entry.areas : allAreas(),
      metrics: entry.metrics,
      presence: fromBase64(entry.presence),
      tou: fromBase64(entry.tou),
      sourceColumns: entry.sourceColumns,
      year: entry.year,
    };
  });
}
