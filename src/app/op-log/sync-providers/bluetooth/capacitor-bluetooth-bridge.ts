import { registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type { BluetoothLink } from '@sp/sync-providers/bluetooth';
import type { FileAdapter } from '@sp/sync-providers/file-based';
import type {
  BluetoothPairedDevice,
  BluetoothPlatformBridge,
} from './bluetooth-platform.port';

interface BluetoothSyncPlugin {
  isAvailable(): Promise<{ isAvailable: boolean }>;
  getLocalDeviceName(): Promise<{ deviceName: string }>;
  listPairedDevices(): Promise<{ devices: BluetoothPairedDevice[] }>;
  connectToDevice(options: { platformAddress: string }): Promise<{ linkId: string }>;
  write(options: { linkId: string; dataBase64: string }): Promise<void>;
  closeLink(options: { linkId: string }): Promise<void>;
  startListening(): Promise<void>;
  stopListening(): Promise<void>;
  readSharedFile(options: { filePath: string }): Promise<{ dataStr: string }>;
  writeSharedFile(options: { filePath: string; dataStr: string }): Promise<void>;
  deleteSharedFile(options: { filePath: string }): Promise<void>;
  listSharedFiles(options: { dirPath: string }): Promise<{ filePaths: string[] }>;
  addListener(
    eventName: 'linkData',
    listener: (event: { linkId: string; dataBase64: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'linkClosed',
    listener: (event: { linkId: string; reason: string | null }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'incomingLink',
    listener: (event: { linkId: string; peerDeviceId: string }) => void,
  ): Promise<PluginListenerHandle>;
}

const notOnThisPlatform = async (): Promise<never> => {
  throw new Error('Bluetooth sync is only available on Android');
};

const BluetoothSyncBridge = registerPlugin<BluetoothSyncPlugin>('BluetoothSyncBridge', {
  web: {
    isAvailable: async () => ({ isAvailable: false }),
    getLocalDeviceName: notOnThisPlatform,
    listPairedDevices: notOnThisPlatform,
    connectToDevice: notOnThisPlatform,
    write: notOnThisPlatform,
    closeLink: notOnThisPlatform,
    startListening: notOnThisPlatform,
    stopListening: notOnThisPlatform,
    readSharedFile: notOnThisPlatform,
    writeSharedFile: notOnThisPlatform,
    deleteSharedFile: notOnThisPlatform,
    listSharedFiles: notOnThisPlatform,
  },
});

const toBase64 = (chunk: Uint8Array): string => {
  let binary = '';
  for (const byte of chunk) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

const fromBase64 = (encoded: string): Uint8Array => {
  const binary = atob(encoded);
  const chunk = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    chunk[index] = binary.charCodeAt(index);
  }
  return chunk;
};

class CapacitorBluetoothLink implements BluetoothLink {
  readonly kind = 'l2capChannel' as const;

  private dataListeners: ((chunk: Uint8Array) => void)[] = [];
  private closeListeners: ((reason: string | null) => void)[] = [];

  constructor(
    readonly linkId: string,
    readonly peerDeviceId: string,
  ) {}

  async write(chunk: Uint8Array): Promise<void> {
    await BluetoothSyncBridge.write({
      linkId: this.linkId,
      dataBase64: toBase64(chunk),
    });
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.dataListeners.push(listener);
  }

  onClose(listener: (reason: string | null) => void): void {
    this.closeListeners.push(listener);
  }

  async close(): Promise<void> {
    await BluetoothSyncBridge.closeLink({ linkId: this.linkId });
  }

  acceptData(chunk: Uint8Array): void {
    for (const listener of this.dataListeners) {
      listener(chunk);
    }
  }

  acceptClose(reason: string | null): void {
    for (const listener of this.closeListeners) {
      listener(reason);
    }
    this.closeListeners = [];
    this.dataListeners = [];
  }
}

class CapacitorBluetoothBridge implements BluetoothPlatformBridge {
  private readonly linksById = new Map<string, CapacitorBluetoothLink>();
  private onIncomingLink: ((link: BluetoothLink) => void) | null = null;
  private subscription: Promise<void> | null = null;

  readonly sharedFileStore: FileAdapter = {
    readFile: async (filePath) =>
      (await BluetoothSyncBridge.readSharedFile({ filePath })).dataStr,
    writeFile: async (filePath, dataStr) => {
      await BluetoothSyncBridge.writeSharedFile({ filePath, dataStr });
    },
    deleteFile: async (filePath) => {
      await BluetoothSyncBridge.deleteSharedFile({ filePath });
    },
    listFiles: async (dirPath) =>
      (await BluetoothSyncBridge.listSharedFiles({ dirPath })).filePaths,
  };

  async isAvailable(): Promise<boolean> {
    return (await BluetoothSyncBridge.isAvailable()).isAvailable;
  }

  async getLocalDeviceName(): Promise<string> {
    return (await BluetoothSyncBridge.getLocalDeviceName()).deviceName;
  }

  async listPairedDevices(): Promise<BluetoothPairedDevice[]> {
    return (await BluetoothSyncBridge.listPairedDevices()).devices;
  }

  async connectToDevice(platformAddress: string): Promise<BluetoothLink> {
    await this.subscribeToPlugin();
    const { linkId } = await BluetoothSyncBridge.connectToDevice({ platformAddress });
    const link = new CapacitorBluetoothLink(linkId, platformAddress);
    this.linksById.set(linkId, link);
    return link;
  }

  async startListening(onIncomingLink: (link: BluetoothLink) => void): Promise<void> {
    this.onIncomingLink = onIncomingLink;
    await this.subscribeToPlugin();
    await BluetoothSyncBridge.startListening();
  }

  async stopListening(): Promise<void> {
    this.onIncomingLink = null;
    await BluetoothSyncBridge.stopListening();
  }

  private subscribeToPlugin(): Promise<void> {
    if (!this.subscription) {
      this.subscription = this.registerPluginListeners();
    }
    return this.subscription;
  }

  private async registerPluginListeners(): Promise<void> {
    await BluetoothSyncBridge.addListener('linkData', ({ linkId, dataBase64 }) => {
      this.linksById.get(linkId)?.acceptData(fromBase64(dataBase64));
    });
    await BluetoothSyncBridge.addListener('linkClosed', ({ linkId, reason }) => {
      const link = this.linksById.get(linkId);
      this.linksById.delete(linkId);
      link?.acceptClose(reason);
    });
    await BluetoothSyncBridge.addListener('incomingLink', ({ linkId, peerDeviceId }) => {
      const link = new CapacitorBluetoothLink(linkId, peerDeviceId);
      this.linksById.set(linkId, link);
      this.onIncomingLink?.(link);
    });
  }
}

export const createCapacitorBluetoothBridge = (): BluetoothPlatformBridge =>
  new CapacitorBluetoothBridge();
