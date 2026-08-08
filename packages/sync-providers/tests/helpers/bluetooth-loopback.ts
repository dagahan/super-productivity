import type { SyncLogger } from '@sp/sync-core';
import type { FileAdapter } from '../../src/file-adapter';
import type { BluetoothLink } from '../../src/bluetooth/bluetooth-link';

export const createSilentSyncLogger = (): SyncLogger => {
  const noop = (): void => undefined;
  return {
    log: noop,
    error: noop,
    err: noop,
    normal: noop,
    verbose: noop,
    info: noop,
    warn: noop,
    critical: noop,
    debug: noop,
  };
};

class LoopbackLink implements BluetoothLink {
  readonly kind = 'l2capChannel' as const;
  peer: LoopbackLink | null = null;

  private dataListeners: ((chunk: Uint8Array) => void)[] = [];
  private closeListeners: ((reason: string | null) => void)[] = [];

  constructor(
    readonly peerDeviceId: string,
    private readonly chunkBytes: number,
  ) {}

  async write(chunk: Uint8Array): Promise<void> {
    const target = this.peer;
    if (!target) {
      throw new Error('Loopback link has no peer');
    }
    for (let offset = 0; offset < chunk.length; offset += this.chunkBytes) {
      const slice = chunk.slice(offset, offset + this.chunkBytes);
      await Promise.resolve();
      target.deliver(slice);
    }
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.dataListeners.push(listener);
  }

  onClose(listener: (reason: string | null) => void): void {
    this.closeListeners.push(listener);
  }

  async close(): Promise<void> {
    this.notifyClosed('closed locally');
    this.peer?.notifyClosed('peer closed the link');
  }

  deliver(chunk: Uint8Array): void {
    for (const listener of this.dataListeners) {
      listener(chunk);
    }
  }

  notifyClosed(reason: string): void {
    for (const listener of this.closeListeners) {
      listener(reason);
    }
    this.closeListeners = [];
  }
}

export const createLinkPair = (
  chunkBytes = 64,
): { initiator: BluetoothLink; responder: BluetoothLink } => {
  const initiator = new LoopbackLink('responder-device', chunkBytes);
  const responder = new LoopbackLink('initiator-device', chunkBytes);
  initiator.peer = responder;
  responder.peer = initiator;
  return { initiator, responder };
};

export const createInMemoryFileAdapter = (
  seed: Record<string, string> = {},
): FileAdapter & { files: Map<string, string> } => {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    files,
    readFile: async (filePath: string): Promise<string> => {
      const contents = files.get(filePath);
      if (contents === undefined) {
        throw new Error(`ENOENT ${filePath}`);
      }
      return contents;
    },
    writeFile: async (filePath: string, dataStr: string): Promise<void> => {
      files.set(filePath, dataStr);
    },
    deleteFile: async (filePath: string): Promise<void> => {
      files.delete(filePath);
    },
    listFiles: async (dirPath: string): Promise<string[]> =>
      [...files.keys()].filter((filePath) => filePath.startsWith(dirPath)),
  };
};
