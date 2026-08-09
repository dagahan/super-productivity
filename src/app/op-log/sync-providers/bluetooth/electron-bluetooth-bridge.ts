import type { BluetoothLink } from '@sp/sync-providers/bluetooth';
import type { FileAdapter } from '@sp/sync-providers/file-based';
import type { ElectronAPI } from '../../../../../electron/electronAPI';
import { IPC } from '../../../../../electron/shared-with-frontend/ipc-events.const';
import type {
  BluetoothPairedDevice,
  BluetoothPlatformBridge,
} from './bluetooth-platform.port';

const getElectronApi = (): ElectronAPI => {
  const maybeWindow = window as Window & { ea?: ElectronAPI };
  if (!maybeWindow.ea) {
    throw new Error('Electron API is not available');
  }
  return maybeWindow.ea;
};

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

class ElectronBluetoothLink implements BluetoothLink {
  readonly kind = 'l2capChannel' as const;

  private dataListeners: ((chunk: Uint8Array) => void)[] = [];
  private closeListeners: ((reason: string | null) => void)[] = [];

  constructor(
    readonly linkId: string,
    readonly peerDeviceId: string,
  ) {}

  async write(chunk: Uint8Array): Promise<void> {
    await getElectronApi().bluetoothSyncWrite({
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
    await getElectronApi().bluetoothSyncCloseLink({ linkId: this.linkId });
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

class ElectronBluetoothBridge implements BluetoothPlatformBridge {
  private readonly linksById = new Map<string, ElectronBluetoothLink>();
  private onIncomingLink: ((link: BluetoothLink) => void) | null = null;
  private hasSubscribedToMain = false;

  readonly sharedFileStore: FileAdapter = {
    readFile: (filePath) => getElectronApi().bluetoothSyncReadSharedFile({ filePath }),
    writeFile: async (filePath, dataStr) => {
      await getElectronApi().bluetoothSyncWriteSharedFile({ filePath, dataStr });
    },
    deleteFile: async (filePath) => {
      await getElectronApi().bluetoothSyncDeleteSharedFile({ filePath });
    },
    listFiles: (dirPath) => getElectronApi().bluetoothSyncListSharedFiles({ dirPath }),
  };

  async isAvailable(): Promise<boolean> {
    return await getElectronApi().bluetoothSyncIsAvailable();
  }

  async getLocalDeviceName(): Promise<string> {
    return await getElectronApi().bluetoothSyncGetLocalDeviceName();
  }

  async listPairedDevices(): Promise<BluetoothPairedDevice[]> {
    return await getElectronApi().bluetoothSyncListPairedDevices();
  }

  async isPeerBonded(platformAddress: string): Promise<boolean> {
    const wanted = platformAddress.replace(/[^0-9a-zA-Z]/g, '').toLowerCase();
    const paired = await this.listPairedDevices();
    return paired.some(
      (device) =>
        device.platformAddress.replace(/[^0-9a-zA-Z]/g, '').toLowerCase() === wanted,
    );
  }

  async connectToDevice(platformAddress: string): Promise<BluetoothLink> {
    this.subscribeToMain();
    const { linkId } = await getElectronApi().bluetoothSyncConnect({ platformAddress });
    const link = new ElectronBluetoothLink(linkId, platformAddress);
    this.linksById.set(linkId, link);
    return link;
  }

  async startListening(onIncomingLink: (link: BluetoothLink) => void): Promise<void> {
    this.onIncomingLink = onIncomingLink;
    this.subscribeToMain();
    await getElectronApi().bluetoothSyncStartListening();
  }

  async stopListening(): Promise<void> {
    this.onIncomingLink = null;
    await getElectronApi().bluetoothSyncStopListening();
  }

  private subscribeToMain(): void {
    if (this.hasSubscribedToMain) {
      return;
    }
    this.hasSubscribedToMain = true;
    const electronApi = getElectronApi();

    electronApi.on(IPC.BLUETOOTH_SYNC_LINK_DATA, (payload) => {
      const { linkId, dataBase64 } = payload as { linkId: string; dataBase64: string };
      this.linksById.get(linkId)?.acceptData(fromBase64(dataBase64));
    });

    electronApi.on(IPC.BLUETOOTH_SYNC_LINK_CLOSED, (payload) => {
      const { linkId, reason } = payload as { linkId: string; reason: string | null };
      const link = this.linksById.get(linkId);
      this.linksById.delete(linkId);
      link?.acceptClose(reason);
    });

    electronApi.on(IPC.BLUETOOTH_SYNC_INCOMING_LINK, (payload) => {
      const { linkId, peerDeviceId } = payload as {
        linkId: string;
        peerDeviceId: string;
      };
      const link = new ElectronBluetoothLink(linkId, peerDeviceId);
      this.linksById.set(linkId, link);
      this.onIncomingLink?.(link);
    });
  }
}

export const createElectronBluetoothBridge = (): BluetoothPlatformBridge =>
  new ElectronBluetoothBridge();
