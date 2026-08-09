import {
  BluetoothFileResponder,
  type IncomingInvitation,
  type InvitationOutcome,
  BluetoothPeerSession,
  BluetoothSyncProvider,
  type BluetoothRoomMember,
  type BluetoothRoomStore,
  type InviteResult,
} from '@sp/sync-providers/bluetooth';
import { OP_LOG_SYNC_LOGGER } from '../../core/sync-logger.adapter';
import { SyncCredentialStore } from '../credential-store.service';
import { SyncProviderId } from '../provider.const';
import { ReachableMemberConnector } from './bluetooth-peer-connector';
import type {
  BluetoothPairedDevice,
  BluetoothPlatformBridge,
} from './bluetooth-platform.port';

type BluetoothCredentialStore = ConstructorParameters<
  typeof BluetoothSyncProvider
>[0]['credentialStore'];

const createLocalDeviceId = (): string =>
  `sp-${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;

const createRoomStore = (
  credentialStore: BluetoothCredentialStore,
  bridge: BluetoothPlatformBridge,
): BluetoothRoomStore => ({
  loadLocalDeviceId: async (): Promise<string> => {
    const cfg = await credentialStore.load();
    if (cfg?.localDeviceId) {
      return cfg.localDeviceId;
    }
    const localDeviceId = createLocalDeviceId();
    await credentialStore.upsertPartial({
      localDeviceId,
      localDeviceName: await bridge.getLocalDeviceName(),
    });
    return localDeviceId;
  },
  loadLocalDeviceName: async (): Promise<string> =>
    (await credentialStore.load())?.localDeviceName ??
    (await bridge.getLocalDeviceName()),
  loadMembers: async (): Promise<BluetoothRoomMember[]> =>
    (await credentialStore.load())?.members ?? [],
  saveMembers: async (members: BluetoothRoomMember[]): Promise<void> => {
    await credentialStore.upsertPartial({ members });
  },
  saveRoomSecret: async (roomId: string, encryptKey: string | null): Promise<void> => {
    await credentialStore.upsertPartial({
      roomId,
      ...(encryptKey ? { encryptKey, isEncryptionEnabled: true } : {}),
    });
  },
});

export const createBluetoothSyncProvider = (
  bridge: BluetoothPlatformBridge,
  askUserAboutInvitation: (invitation: IncomingInvitation) => Promise<InvitationOutcome>,
): BluetoothSyncProvider => {
  const logger = OP_LOG_SYNC_LOGGER;
  const credentialStore = new SyncCredentialStore(
    SyncProviderId.Bluetooth,
  ) as BluetoothCredentialStore;
  const room = createRoomStore(credentialStore, bridge);

  const responder = new BluetoothFileResponder({
    fileAdapter: bridge.sharedFileStore,
    logger,
    room,
    isPeerBonded: (peerAddress) => bridge.isPeerBonded(peerAddress),
    askUserAboutInvitation: (invitation) => askUserAboutInvitation(invitation),
  });

  const connector = new ReachableMemberConnector({
    bridge,
    logger,
    loadMembers: room.loadMembers,
    createPeerHandler: (peerAddress) => responder.createPeerHandler(peerAddress),
  });

  void bridge
    .startListening((link) => {
      new BluetoothPeerSession({
        link,
        handleRequest: responder.createPeerHandler(link.peerDeviceId),
      });
    })
    .catch((error: unknown) => {
      logger.critical('Bluetooth sync could not start listening for peers', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    });

  const provider = new BluetoothSyncProvider({ logger, connector, credentialStore });
  return Object.assign(provider, {
    listPairedDevices: () => bridge.listPairedDevices(),
    loadRoom: async (): Promise<BluetoothRoomView> => ({
      localDeviceId: await room.loadLocalDeviceId(),
      localDeviceName:
        (await credentialStore.load())?.localDeviceName ??
        (await bridge.getLocalDeviceName()),
      members: await room.loadMembers(),
    }),
    saveRoomMembers: (members: BluetoothRoomMember[]) => room.saveMembers(members),
    invitePeer: async (
      platformAddress: string,
      deviceName: string,
    ): Promise<InviteResult> => {
      const cfg = await credentialStore.load();
      const roomId = cfg?.roomId ?? createLocalDeviceId();
      const result = await provider.invitePeer({
        platformAddress,
        roomId,
        inviterDeviceId: await room.loadLocalDeviceId(),
        inviterDeviceName: await room.loadLocalDeviceName(),
        encryptKey: cfg?.encryptKey ?? null,
      });
      if (result.decision === 'accepted') {
        const members = await room.loadMembers();
        await room.saveMembers([
          ...members,
          {
            deviceId: result.deviceId,
            deviceName: result.deviceName || deviceName,
            platformAddress,
            isTrustedToInvite: false,
            invitedByDeviceId: null,
          },
        ]);
        await credentialStore.upsertPartial({ roomId });
      }
      return result;
    },
  });
};

export interface BluetoothRoomView {
  localDeviceId: string;
  localDeviceName: string;
  members: BluetoothRoomMember[];
}

export interface BluetoothRoomEditor {
  listPairedDevices(): Promise<BluetoothPairedDevice[]>;
  loadRoom(): Promise<BluetoothRoomView>;
  saveRoomMembers(members: BluetoothRoomMember[]): Promise<void>;
  invitePeer(platformAddress: string, deviceName: string): Promise<InviteResult>;
}
