// src/storage-worker.ts
//
// OPFS read/write through `createSyncAccessHandle`, which is the fast path
// and is worker-only. The bundle is
//
//   [4-byte manifest length][UTF-8 JSON manifest][cube bytes, case by case]
//
// A raw Float32Array dump, settled in D12: the deciding metric was
// decode-to-Float32Array time, and a raw dump is already decoded. Nothing
// beats a memcpy on that axis.
//
// Saving streams case by case rather than accepting one giant message: a
// structured clone of ten cubes at once would be a 750 MB transient on top
// of the cubes themselves. Loading transfers the buffers out, which costs
// nothing, because the worker has no further use for them.

const FILE_NAME = 'gridview-bundle.bin';
const HEADER_BYTES = 4;

export interface SaveBegin {
  kind: 'saveBegin';
  manifest: string;
}
export interface SaveChunk {
  kind: 'saveChunk';
  bytes: Uint8Array;
}
export interface SaveEnd {
  kind: 'saveEnd';
}
export interface LoadAll {
  kind: 'load';
}
export type StorageRequest = SaveBegin | SaveChunk | SaveEnd | LoadAll;

export interface StorageOk {
  kind: 'ok';
  /** Bytes written so far, for the progress readout. */
  written?: number;
}
export interface StorageLoaded {
  kind: 'loaded';
  manifest: string;
  cubes: ArrayBuffer[];
}
export interface StorageError {
  kind: 'error';
  message: string;
}
export type StorageResponse = StorageOk | StorageLoaded | StorageError;

type SyncHandle = {
  write(buffer: ArrayBufferView | ArrayBuffer, options?: { at?: number }): number;
  read(buffer: ArrayBufferView | ArrayBuffer, options?: { at?: number }): number;
  truncate(size: number): void;
  getSize(): number;
  flush(): void;
  close(): void;
};

let handle: SyncHandle | null = null;
let offset = 0;

async function openHandle(create: boolean): Promise<SyncHandle> {
  const root = await navigator.storage.getDirectory();
  const file = await root.getFileHandle(FILE_NAME, { create });
  // Typed loosely: createSyncAccessHandle is worker-only and not in every
  // lib.dom.d.ts yet.
  return (await (file as unknown as {
    createSyncAccessHandle(): Promise<SyncHandle>;
  }).createSyncAccessHandle()) as SyncHandle;
}

function post(message: StorageResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}

self.onmessage = async (event: MessageEvent<StorageRequest>) => {
  const message = event.data;
  try {
    if (message.kind === 'saveBegin') {
      handle = await openHandle(true);
      handle.truncate(0);
      const manifest = new TextEncoder().encode(message.manifest);
      const header = new Uint8Array(HEADER_BYTES);
      new DataView(header.buffer).setUint32(0, manifest.byteLength, true);
      handle.write(header, { at: 0 });
      handle.write(manifest, { at: HEADER_BYTES });
      offset = HEADER_BYTES + manifest.byteLength;
      post({ kind: 'ok', written: offset });
      return;
    }

    if (message.kind === 'saveChunk') {
      if (!handle) throw new Error('saveChunk before saveBegin');
      handle.write(message.bytes, { at: offset });
      offset += message.bytes.byteLength;
      post({ kind: 'ok', written: offset });
      return;
    }

    if (message.kind === 'saveEnd') {
      if (!handle) throw new Error('saveEnd before saveBegin');
      handle.flush();
      handle.close();
      handle = null;
      post({ kind: 'ok', written: offset });
      return;
    }

    // load
    const reader = await openHandle(false);
    try {
      const header = new Uint8Array(HEADER_BYTES);
      reader.read(header, { at: 0 });
      const manifestLength = new DataView(header.buffer).getUint32(0, true);
      const manifestBytes = new Uint8Array(manifestLength);
      reader.read(manifestBytes, { at: HEADER_BYTES });
      const manifest = new TextDecoder().decode(manifestBytes);

      const parsed = JSON.parse(manifest) as { cases: { cubeBytes: number }[] };
      let at = HEADER_BYTES + manifestLength;
      const cubes: ArrayBuffer[] = [];
      for (const entry of parsed.cases) {
        const bytes = new Uint8Array(entry.cubeBytes);
        reader.read(bytes, { at });
        at += entry.cubeBytes;
        cubes.push(bytes.buffer);
      }
      post({ kind: 'loaded', manifest, cubes }, cubes);
    } finally {
      reader.close();
    }
  } catch (error) {
    if (handle) {
      try {
        handle.close();
      } catch {
        // already closed
      }
      handle = null;
    }
    post({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
