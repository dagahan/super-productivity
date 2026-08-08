export type BluetoothLinkKind = 'l2capChannel' | 'rfcommSocket';

export interface BluetoothLink {
  readonly kind: BluetoothLinkKind;
  readonly peerDeviceId: string;
  write(chunk: Uint8Array): Promise<void>;
  onData(listener: (chunk: Uint8Array) => void): void;
  onClose(listener: (reason: string | null) => void): void;
  close(): Promise<void>;
}

export class BluetoothLinkClosedError extends Error {
  constructor(reason: string | null) {
    super(reason ?? 'Bluetooth link closed');
  }
}

export class BluetoothRequestTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`Bluetooth request "${method}" timed out after ${timeoutMs}ms`);
  }
}
