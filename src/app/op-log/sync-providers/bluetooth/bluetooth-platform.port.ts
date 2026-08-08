import type { BluetoothLink } from '@sp/sync-providers/bluetooth';
import type { FileAdapter } from '@sp/sync-providers/file-based';

export interface BluetoothPairedDevice {
  platformAddress: string;
  deviceName: string;
  isCurrentlyConnected: boolean;
}

export interface BluetoothPlatformBridge {
  readonly sharedFileStore: FileAdapter;
  isAvailable(): Promise<boolean>;
  getLocalDeviceName(): Promise<string>;
  listPairedDevices(): Promise<BluetoothPairedDevice[]>;
  connectToDevice(platformAddress: string): Promise<BluetoothLink>;
  startListening(onIncomingLink: (link: BluetoothLink) => void): Promise<void>;
  stopListening(): Promise<void>;
}
