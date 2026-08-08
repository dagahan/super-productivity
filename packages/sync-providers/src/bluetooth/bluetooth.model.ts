export const PROVIDER_ID_BLUETOOTH = 'Bluetooth' as const;

export interface BluetoothRoomMember {
  deviceId: string;
  deviceName: string;
  platformAddress: string;
  isTrustedToInvite: boolean;
  invitedByDeviceId: string | null;
}

export interface BluetoothSyncPrivateCfg {
  encryptKey?: string;
  isEncryptionEnabled?: boolean;
  roomId?: string;
  localDeviceId?: string;
  localDeviceName?: string;
  members?: BluetoothRoomMember[];
}
