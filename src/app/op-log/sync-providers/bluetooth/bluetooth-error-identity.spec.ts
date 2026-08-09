import {
  BluetoothPeerError,
  BluetoothSyncProvider,
  PROVIDER_ID_BLUETOOTH,
  type BluetoothPeerConnector,
  type BluetoothSyncPrivateCfg,
} from '@sp/sync-providers/bluetooth';
import type { SyncCredentialStorePort } from '@sp/sync-providers/credential-store';
import type { SyncLogger } from '@sp/sync-core';
import { RemoteFileNotFoundAPIError } from '../../core/errors/sync-errors';

const silentLogger = (): SyncLogger => {
  const noop = (): void => undefined;
  return {
    log: noop,
    error: noop,
    err: noop,
    normal: noop,
    verbose: noop,
    info: noop,
    warn: noop,
    critical: noop,
    debug: noop,
  };
};

const storedCfg: BluetoothSyncPrivateCfg = {
  roomId: 'room-1',
  localDeviceId: 'sp-local',
  localDeviceName: 'Local',
  members: [
    {
      deviceId: 'sp-peer',
      deviceName: 'Peer',
      platformAddress: '44:CB:AD:5D:06:4D',
      isTrustedToInvite: false,
      invitedByDeviceId: null,
    },
  ],
};

const credentialStoreReturning = (): SyncCredentialStorePort<
  typeof PROVIDER_ID_BLUETOOTH,
  BluetoothSyncPrivateCfg
> =>
  ({
    load: async () => storedCfg,
    setComplete: async () => undefined,
    upsertPartial: async () => undefined,
    updatePartial: async () => undefined,
  }) as unknown as SyncCredentialStorePort<
    typeof PROVIDER_ID_BLUETOOTH,
    BluetoothSyncPrivateCfg
  >;

const connectorFailingFileRequestsWith = (error: Error): BluetoothPeerConnector => {
  const session = {
    createRequestId: () => '1',
    send: async (request: { method: string }) => {
      if (request.method === 'hello') {
        return { protocolVersion: 1, deviceId: 'sp-peer', members: [] };
      }
      throw error;
    },
    close: async () => undefined,
  };
  return {
    isAvailable: async () => true,
    connectToDevice: async () => session,
    connectToAnyReachableMember: async () => session,
  } as unknown as BluetoothPeerConnector;
};

// Regression guard for the same dual-realm hazard as sync-errors.identity.spec.ts,
// on the import path that spec cannot see: the provider throws errors constructed
// inside @sp/sync-providers/bluetooth, while FileBasedSyncAdapterService catches
// them with the class from @sp/sync-providers/errors. If the two entry points
// resolve to different realms (a missing tsconfig path mapping sends one to dist
// and the other to src), every `instanceof RemoteFileNotFoundAPIError` guard in
// the adapter silently stops matching and a first sync against an empty peer
// fails instead of uploading.
describe('bluetooth provider error identity', () => {
  it('surfaces a missing peer file as the adapter-catchable RemoteFileNotFoundAPIError', async () => {
    const provider = new BluetoothSyncProvider({
      logger: silentLogger(),
      connector: connectorFailingFileRequestsWith(
        new BluetoothPeerError(
          'remoteFileNotFound',
          'Peer has no file at sync-data.json',
        ),
      ),
      credentialStore: credentialStoreReturning(),
      localReplica: {
        readFile: async () => '',
        writeFile: async () => undefined,
        deleteFile: async () => undefined,
      },
    });

    await expectAsync(provider.downloadFile('sync-data.json')).toBeRejectedWithError(
      RemoteFileNotFoundAPIError,
    );
  });
});
