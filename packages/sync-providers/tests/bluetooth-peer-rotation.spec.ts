import { describe, expect, it, vi } from 'vitest';
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
import { createStatefulCredentialStore } from './helpers/credential-store';
import {
  createInMemoryFileAdapter,
  createLinkPair,
  createSilentSyncLogger,
} from './helpers/bluetooth-loopback';

const SYNC_PATH = 'sp-sync.json';
const PIN_IDLE_MS = 45_000;

const member = (deviceId: string, platformAddress: string): BluetoothRoomMember => ({
  deviceId,
  deviceName: `${deviceId} name`,
  platformAddress,
  isTrustedToInvite: false,
  invitedByDeviceId: null,
});

const PIXEL = member('sp-pixel', '84:2F:57:52:C4:C6');
const REDMI = member('sp-redmi', '44:CB:AD:5D:06:4D');
const LOCAL = member('sp-mac', 'local-address');

interface Room {
  provider: BluetoothSyncProvider;
  filesOf: (deviceId: string) => Map<string, string>;
  dialledAddresses: string[];
  advanceIdle: () => void;
}

const createRoom = ({
  members = [PIXEL, REDMI],
  seeds = {} as Record<string, Record<string, string>>,
  unreachableAddresses = [] as string[],
}: {
  members?: BluetoothRoomMember[];
  seeds?: Record<string, Record<string, string>>;
  unreachableAddresses?: string[];
} = {}): Room => {
  const logger = createSilentSyncLogger();
  const dialledAddresses: string[] = [];
  const adapters = new Map<string, ReturnType<typeof createInMemoryFileAdapter>>();
  let now = 1_000_000;

  const sessionFor = (peer: BluetoothRoomMember): BluetoothPeerSession => {
    const { initiator, responder } = createLinkPair();
    const adapter =
      adapters.get(peer.deviceId) ??
      createInMemoryFileAdapter(seeds[peer.deviceId] ?? {});
    adapters.set(peer.deviceId, adapter);

    let peerMembers = [
      LOCAL,
      ...members.filter((other) => other.deviceId !== peer.deviceId),
    ];
    const fileResponder = new BluetoothFileResponder({
      fileAdapter: adapter,
      logger,
      isPeerBonded: async () => true,
      askUserAboutInvitation: async () => ({
        decision: 'accepted',
        isTrustedToInvite: false,
      }),
      room: {
        loadLocalDeviceId: async () => peer.deviceId,
        loadLocalDeviceName: async () => peer.deviceName,
        loadMembers: async () => peerMembers,
        saveMembers: async (next) => {
          peerMembers = next;
        },
        saveRoomSecret: async () => undefined,
      },
    });

    new BluetoothPeerSession({
      link: responder,
      handleRequest: fileResponder.createPeerHandler('local-address'),
    });
    return new BluetoothPeerSession({
      link: initiator,
      handleRequest: async (request) => ({
        id: request.id,
        isOk: false,
        errorCode: 'unknown',
        errorMessage: 'the local device serves nothing in this test',
      }),
    });
  };

  const reachedAt = new Map<string, number>();
  const connectToDevice = async (
    platformAddress: string,
  ): Promise<BluetoothPeerSession> => {
    const peer = members.find((other) => other.platformAddress === platformAddress);
    if (!peer || unreachableAddresses.includes(platformAddress)) {
      throw new Error(`${platformAddress} is not reachable`);
    }
    dialledAddresses.push(platformAddress);
    reachedAt.set(platformAddress, now);
    return sessionFor(peer);
  };

  const connector: BluetoothPeerConnector = {
    isAvailable: async () => true,
    connectToDevice,
    connectToAnyReachableMember: async () => {
      const ordered = [...members].sort(
        (left, right) =>
          (reachedAt.get(left.platformAddress) ?? 0) -
          (reachedAt.get(right.platformAddress) ?? 0),
      );
      for (const candidate of ordered) {
        try {
          return await connectToDevice(candidate.platformAddress);
        } catch {
          continue;
        }
      }
      throw new Error('no member reachable');
    },
  };

  const credentialStore = createStatefulCredentialStore<
    typeof PROVIDER_ID_BLUETOOTH,
    BluetoothSyncPrivateCfg
  >({
    roomId: 'room-1',
    localDeviceId: 'sp-mac',
    localDeviceName: 'Laptop',
    members,
  });

  vi.spyOn(Date, 'now').mockImplementation(() => now);

  return {
    provider: new BluetoothSyncProvider({
      logger,
      connector,
      credentialStore,
      localReplica: createInMemoryFileAdapter(),
      peerPinIdleMs: PIN_IDLE_MS,
    }),
    filesOf: (deviceId) => {
      const adapter = adapters.get(deviceId) ?? createInMemoryFileAdapter();
      adapters.set(deviceId, adapter);
      return adapter.files;
    },
    dialledAddresses,
    advanceIdle: () => {
      now += PIN_IDLE_MS;
    },
  };
};

describe('bluetooth sync target key', () => {
  it('namespaces the adapter cursor by peer, not by provider', async () => {
    const room = createRoom();

    const firstPeer = await room.provider.resolveSyncTargetKey();
    room.advanceIdle();
    const secondPeer = await room.provider.resolveSyncTargetKey();

    expect([firstPeer, secondPeer].sort()).toEqual(['sp-pixel', 'sp-redmi']);
  });

  it('keeps one cycle on one peer so an upload matches the rev its download read', async () => {
    const room = createRoom();

    const pinnedPeer = await room.provider.resolveSyncTargetKey();
    await room.provider.uploadFile(SYNC_PATH, '{"ops":["a"]}', null);
    const stillPinned = await room.provider.resolveSyncTargetKey();

    expect(stillPinned).toBe(pinnedPeer);
    expect(room.filesOf(pinnedPeer).get(SYNC_PATH)).toBe('{"ops":["a"]}');
  });

  it('moves to the other member once the pin has gone idle', async () => {
    const room = createRoom();
    const firstPeer = await room.provider.resolveSyncTargetKey();

    room.advanceIdle();
    const secondPeer = await room.provider.resolveSyncTargetKey();

    expect(secondPeer).not.toBe(firstPeer);
  });

  it('keeps the link in a two-device room, where rotation has nowhere to go', async () => {
    const room = createRoom({ members: [PIXEL] });
    await room.provider.resolveSyncTargetKey();

    room.advanceIdle();
    await room.provider.resolveSyncTargetKey();

    expect(room.dialledAddresses).toEqual([PIXEL.platformAddress]);
  });

  it('gives every member a turn rather than revisiting the nearest one', async () => {
    const room = createRoom();

    for (let cycle = 0; cycle < 4; cycle++) {
      await room.provider.resolveSyncTargetKey();
      room.advanceIdle();
    }

    expect(room.dialledAddresses).toEqual([
      PIXEL.platformAddress,
      REDMI.platformAddress,
      PIXEL.platformAddress,
      REDMI.platformAddress,
    ]);
  });

  it('stays on the pinned peer when a mid-cycle request drops the link', async () => {
    const room = createRoom();
    const pinnedPeer = await room.provider.resolveSyncTargetKey();

    await room.provider.uploadFile(SYNC_PATH, '{"ops":["a"]}', null);
    const afterReconnect = await room.provider.resolveSyncTargetKey();

    expect(afterReconnect).toBe(pinnedPeer);
  });

  it('falls back to a reachable member when the pinned one has gone away', async () => {
    const room = createRoom({ unreachableAddresses: [PIXEL.platformAddress] });

    const peer = await room.provider.resolveSyncTargetKey();

    expect(peer).toBe(REDMI.deviceId);
  });
});
