import { describe, expect, it } from 'vitest';
import { UploadRevToMatchMismatchAPIError } from '../src/errors';
import { BluetoothFileResponder } from '../src/bluetooth/bluetooth-file-responder';
import { BluetoothPeerSession } from '../src/bluetooth/bluetooth-peer-session';
import {
  BluetoothSyncProvider,
  type BluetoothPeerConnector,
} from '../src/bluetooth/bluetooth-sync-provider';
import {
  PROVIDER_ID_BLUETOOTH,
  type BluetoothRoomMember,
  type BluetoothSyncPrivateCfg,
} from '../src/bluetooth/bluetooth.model';
import { RemoteFileNotFoundAPIError } from '../src/errors';
import { createStatefulCredentialStore } from './helpers/credential-store';
import {
  createInMemoryFileAdapter,
  createLinkPair,
  createSilentSyncLogger,
} from './helpers/bluetooth-loopback';

const SYNC_PATH = 'sp-sync.json';

const DEVICE_IDS = ['sp-mac', 'sp-pixel', 'sp-redmi'] as const;
type DeviceId = (typeof DEVICE_IDS)[number];

const addressOf = (deviceId: DeviceId): string => `address-${deviceId}`;

const memberOf = (deviceId: DeviceId): BluetoothRoomMember => ({
  deviceId,
  deviceName: `${deviceId} name`,
  platformAddress: addressOf(deviceId),
  isTrustedToInvite: false,
  invitedByDeviceId: null,
});

const readOps = (contents: string | undefined): string[] =>
  contents ? (JSON.parse(contents).ops as string[]) : [];

const writeOps = (ops: string[]): string =>
  JSON.stringify({ ops: [...new Set(ops)].sort() });

interface Device {
  deviceId: DeviceId;
  provider: BluetoothSyncProvider;
  files: Map<string, string>;
  localOps: () => string[];
  edit: (opId: string) => void;
  meet: (peer: Device) => Promise<void>;
}

const createRoom = (): { devices: Record<DeviceId, Device> } => {
  const logger = createSilentSyncLogger();
  const members = DEVICE_IDS.map(memberOf);
  const adapters = new Map(
    DEVICE_IDS.map((deviceId) => [deviceId, createInMemoryFileAdapter()]),
  );

  const sessionTo = (
    callerDeviceId: DeviceId,
    peerDeviceId: DeviceId,
  ): BluetoothPeerSession => {
    const { initiator, responder } = createLinkPair();
    let peerMembers = members.filter((member) => member.deviceId !== peerDeviceId);
    const fileResponder = new BluetoothFileResponder({
      fileAdapter: adapters.get(peerDeviceId)!,
      logger,
      isPeerBonded: async () => true,
      askUserAboutInvitation: async () => ({
        decision: 'accepted',
        isTrustedToInvite: false,
      }),
      room: {
        loadLocalDeviceId: async () => peerDeviceId,
        loadLocalDeviceName: async () => `${peerDeviceId} name`,
        loadMembers: async () => peerMembers,
        saveMembers: async (next) => {
          peerMembers = next;
        },
        saveRoomSecret: async () => undefined,
      },
    });

    new BluetoothPeerSession({
      link: responder,
      handleRequest: fileResponder.createPeerHandler(addressOf(callerDeviceId)),
    });
    return new BluetoothPeerSession({
      link: initiator,
      handleRequest: async (request) => ({
        id: request.id,
        isOk: false,
        errorCode: 'unknown',
        errorMessage: 'the caller serves nothing in this test',
      }),
    });
  };

  const createDevice = (deviceId: DeviceId): Device => {
    let peerInRange: DeviceId | null = null;
    const connector: BluetoothPeerConnector = {
      isAvailable: async () => true,
      connectToDevice: async (platformAddress) => {
        const peer = DEVICE_IDS.find((other) => addressOf(other) === platformAddress);
        if (!peer || peer === deviceId) {
          throw new Error(`${platformAddress} is not reachable`);
        }
        return sessionTo(deviceId, peer);
      },
      connectToAnyReachableMember: async () => {
        if (!peerInRange) {
          throw new Error(`${deviceId} has no member in range`);
        }
        return sessionTo(deviceId, peerInRange);
      },
    };

    const provider = new BluetoothSyncProvider({
      logger,
      connector,
      credentialStore: createStatefulCredentialStore<
        typeof PROVIDER_ID_BLUETOOTH,
        BluetoothSyncPrivateCfg
      >({
        roomId: 'room-1',
        localDeviceId: deviceId,
        localDeviceName: `${deviceId} name`,
        members: members.filter((member) => member.deviceId !== deviceId),
      }),
      localReplica: adapters.get(deviceId)!,
    });

    const files = adapters.get(deviceId)!.files;
    return {
      deviceId,
      provider,
      files,
      localOps: () => readOps(files.get(SYNC_PATH)),
      edit: (opId) => {
        files.set(SYNC_PATH, writeOps([...readOps(files.get(SYNC_PATH)), opId]));
      },
      meet: async (peer) => {
        peerInRange = peer.deviceId;
        await provider.disconnect();
      },
    };
  };

  return {
    devices: Object.fromEntries(
      DEVICE_IDS.map((deviceId) => [deviceId, createDevice(deviceId)]),
    ) as Record<DeviceId, Device>,
  };
};

const syncOnce = async (device: Device, peer: Device): Promise<string[]> => {
  await device.meet(peer);
  let peerOps: string[] = [];
  let peerRev: string | null = null;
  try {
    const download = await device.provider.downloadFile(SYNC_PATH);
    peerOps = readOps(download.dataStr);
    peerRev = download.rev;
  } catch (error) {
    if (!(error instanceof RemoteFileNotFoundAPIError)) {
      throw error;
    }
  }
  const merged = [...new Set([...device.localOps(), ...peerOps])].sort();
  await device.provider.uploadFile(SYNC_PATH, writeOps(merged), peerRev);
  return merged;
};

const editAndSync = async (
  device: Device,
  peer: Device,
  opId: string,
): Promise<string[]> => {
  device.edit(opId);
  return await syncOnce(device, peer);
};

describe('bluetooth room convergence', () => {
  it('carries the union rather than one side replacing the other', async () => {
    const { devices } = createRoom();
    devices['sp-mac'].edit('mac-1');
    devices['sp-pixel'].edit('pixel-1');

    await syncOnce(devices['sp-mac'], devices['sp-pixel']);

    expect(devices['sp-mac'].localOps()).toEqual(['mac-1', 'pixel-1']);
    expect(devices['sp-pixel'].localOps()).toEqual(['mac-1', 'pixel-1']);
  });

  it('lets a stale third device add its work without rolling anything back', async () => {
    const { devices } = createRoom();
    devices['sp-mac'].edit('mac-1');
    devices['sp-pixel'].edit('pixel-1');
    await syncOnce(devices['sp-mac'], devices['sp-pixel']);

    await editAndSync(devices['sp-redmi'], devices['sp-mac'], 'redmi-1');

    expect(devices['sp-redmi'].localOps()).toEqual(['mac-1', 'pixel-1', 'redmi-1']);
    expect(devices['sp-mac'].localOps()).toEqual(['mac-1', 'pixel-1', 'redmi-1']);
  });

  it('refuses a write from a device whose peer moved on since it read', async () => {
    const { devices } = createRoom();
    devices['sp-mac'].edit('mac-1');
    await syncOnce(devices['sp-mac'], devices['sp-pixel']);

    await devices['sp-redmi'].meet(devices['sp-mac']);
    const staleRev = (await devices['sp-redmi'].provider.downloadFile(SYNC_PATH)).rev;
    await editAndSync(devices['sp-pixel'], devices['sp-mac'], 'pixel-late');

    await expect(
      devices['sp-redmi'].provider.uploadFile(
        SYNC_PATH,
        writeOps(['redmi-only']),
        staleRev,
      ),
    ).rejects.toBeInstanceOf(UploadRevToMatchMismatchAPIError);
    expect(readOps(devices['sp-mac'].files.get(SYNC_PATH))).toContain('pixel-late');
  });

  it('reaches a device that never met the author, through the one in between', async () => {
    const { devices } = createRoom();

    await editAndSync(devices['sp-pixel'], devices['sp-mac'], 'pixel-1');
    await editAndSync(devices['sp-redmi'], devices['sp-mac'], 'redmi-1');
    await syncOnce(devices['sp-pixel'], devices['sp-mac']);

    expect(devices['sp-pixel'].localOps()).toEqual(['pixel-1', 'redmi-1']);
  });

  it('converges whatever order the devices happen to meet in', async () => {
    const { devices } = createRoom();
    devices['sp-mac'].edit('mac-1');
    devices['sp-pixel'].edit('pixel-1');
    devices['sp-redmi'].edit('redmi-1');

    await syncOnce(devices['sp-redmi'], devices['sp-pixel']);
    await syncOnce(devices['sp-mac'], devices['sp-pixel']);
    await syncOnce(devices['sp-pixel'], devices['sp-mac']);
    await syncOnce(devices['sp-redmi'], devices['sp-mac']);

    const everything = ['mac-1', 'pixel-1', 'redmi-1'];
    expect(devices['sp-mac'].localOps()).toEqual(everything);
    expect(devices['sp-pixel'].localOps()).toEqual(everything);
    expect(devices['sp-redmi'].localOps()).toEqual(everything);
  });

  it('settles instead of trading the same work back and forth', async () => {
    const { devices } = createRoom();
    devices['sp-mac'].edit('mac-1');
    devices['sp-pixel'].edit('pixel-1');
    await syncOnce(devices['sp-mac'], devices['sp-pixel']);

    const settled = devices['sp-mac'].files.get(SYNC_PATH);
    await syncOnce(devices['sp-mac'], devices['sp-pixel']);
    await syncOnce(devices['sp-pixel'], devices['sp-mac']);

    expect(devices['sp-mac'].files.get(SYNC_PATH)).toBe(settled);
    expect(devices['sp-pixel'].files.get(SYNC_PATH)).toBe(settled);
  });
});
