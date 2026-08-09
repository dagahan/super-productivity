import type { ElectronAPI } from '../../../../../electron/electronAPI';
import { createElectronBluetoothBridge } from './electron-bluetooth-bridge';

interface ConnectArgs {
  platformAddress: string;
  deviceName: string;
}

const REDMI_PAD = {
  platformAddress: '44:CB:AD:5D:06:4D',
  deviceName: 'Redmi Pad 2 Pro',
  isCurrentlyConnected: false,
};

const installElectronApi = (): ConnectArgs[] => {
  const connectCalls: ConnectArgs[] = [];
  const electronApi = {
    bluetoothSyncListPairedDevices: async () => [REDMI_PAD],
    bluetoothSyncConnect: async (args: ConnectArgs) => {
      connectCalls.push(args);
      return { linkId: 'link-1' };
    },
    on: () => undefined,
  } as unknown as ElectronAPI;
  window.ea = electronApi;
  return connectCalls;
};

describe('electron bluetooth bridge', () => {
  let connectCalls: ConnectArgs[];

  beforeEach(() => {
    connectCalls = installElectronApi();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'ea');
  });

  it('sends the paired name macOS needs to find a classic-addressed peer', async () => {
    await createElectronBluetoothBridge().connectToDevice(REDMI_PAD.platformAddress);

    expect(connectCalls).toEqual([
      { platformAddress: REDMI_PAD.platformAddress, deviceName: REDMI_PAD.deviceName },
    ]);
  });

  it('asks for no name once the peer is addressed by CoreBluetooth identifier', async () => {
    const identifier = '674CF748-0F4A-4E28-9E6E-7B0A2C1D4E55';

    await createElectronBluetoothBridge().connectToDevice(identifier);

    expect(connectCalls).toEqual([{ platformAddress: identifier, deviceName: '' }]);
  });
});
