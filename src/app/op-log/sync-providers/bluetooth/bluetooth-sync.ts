import {
  BluetoothFileResponder,
  BluetoothPeerSession,
  BluetoothSyncProvider,
  type BluetoothRoomMember,
  type BluetoothRoomStore,
} from '@sp/sync-providers/bluetooth';
import { OP_LOG_SYNC_LOGGER } from '../../core/sync-logger.adapter';
import { SyncCredentialStore } from '../credential-store.service';
import { SyncProviderId } from '../provider.const';
import { ReachableMemberConnector } from './bluetooth-peer-connector';
import type { BluetoothPlatformBridge } from './bluetooth-platform.port';

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
    await credentialStore.updatePartial({
      localDeviceId,
      localDeviceName: await bridge.getLocalDeviceName(),
    });
    return localDeviceId;
  },
  loadMembers: async (): Promise<BluetoothRoomMember[]> =>
    (await credentialStore.load())?.members ?? [],
  saveMembers: async (members: BluetoothRoomMember[]): Promise<void> => {
    await credentialStore.updatePartial({ members });
  },
});

export const createBluetoothSyncProvider = (
  bridge: BluetoothPlatformBridge,
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
  });

  const connector = new ReachableMemberConnector({
    bridge,
    logger,
    loadMembers: room.loadMembers,
    handleRequest: responder.handleRequest,
  });

  void bridge
    .startListening((link) => {
      new BluetoothPeerSession({ link, handleRequest: responder.handleRequest });
    })
    .catch((error: unknown) => {
      logger.critical('Bluetooth sync could not start listening for peers', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    });

  return new BluetoothSyncProvider({ logger, connector, credentialStore });
};
