import { describe, expect, it } from 'vitest';
import { md5 } from 'hash-wasm';
import {
  RemoteFileNotFoundAPIError,
  UploadRevToMatchMismatchAPIError,
} from '../src/errors';
import { BluetoothFileResponder } from '../src/bluetooth/bluetooth-file-responder';
import {
  BluetoothPeerError,
  BluetoothPeerSession,
} from '../src/bluetooth/bluetooth-peer-session';
import {
  BluetoothSyncProvider,
  type BluetoothPeerConnector,
} from '../src/bluetooth/bluetooth-sync-provider';
import {
  PROVIDER_ID_BLUETOOTH,
  type BluetoothRoomMember,
  type BluetoothSyncPrivateCfg,
} from '../src/bluetooth/bluetooth.model';
import type { SyncCredentialStorePort } from '../src/credential-store-port';
import { createStatefulCredentialStore } from './helpers/credential-store';
import {
  createInMemoryFileAdapter,
  createLinkPair,
  createSilentSyncLogger,
} from './helpers/bluetooth-loopback';

const SYNC_PATH = 'sp-sync.json';

interface PairedPeers {
  provider: BluetoothSyncProvider;
  credentialStore: SyncCredentialStorePort<
    typeof PROVIDER_ID_BLUETOOTH,
    BluetoothSyncPrivateCfg
  >;
  remoteFiles: Map<string, string>;
  localReplicaFiles: Map<string, string>;
  readRemoteMembers: () => BluetoothRoomMember[];
  closeResponderLink: () => Promise<void>;
}

const remoteMember = (
  deviceId: string,
  isTrustedToInvite = false,
): BluetoothRoomMember => ({
  deviceId,
  deviceName: `${deviceId} name`,
  platformAddress: '44:CB:AD:5D:06:4D',
  isTrustedToInvite,
  invitedByDeviceId: null,
});

const createPairedPeers = ({
  remoteSeed = {},
  remoteMembers = [remoteMember('local-device')],
  localMembers = [remoteMember('remote-device')],
  chunkBytes = 64,
}: {
  remoteSeed?: Record<string, string>;
  remoteMembers?: BluetoothRoomMember[];
  localMembers?: BluetoothRoomMember[];
  chunkBytes?: number;
} = {}): PairedPeers => {
  const logger = createSilentSyncLogger();
  const { initiator, responder } = createLinkPair(chunkBytes);
  const remoteAdapter = createInMemoryFileAdapter(remoteSeed);
  let remoteRoomMembers = remoteMembers;

  const fileResponder = new BluetoothFileResponder({
    fileAdapter: remoteAdapter,
    logger,
    isPeerBonded: async () => true,
    askUserAboutInvitation: async () => ({
      decision: 'accepted',
      isTrustedToInvite: false,
    }),
    room: {
      loadLocalDeviceId: async () => 'remote-device',
      loadLocalDeviceName: async () => 'Tablet',
      loadMembers: async () => remoteRoomMembers,
      saveMembers: async (members) => {
        remoteRoomMembers = members;
      },
      saveRoomSecret: async () => undefined,
    },
  });

  new BluetoothPeerSession({
    link: responder,
    handleRequest: fileResponder.createPeerHandler('44:CB:AD:5D:06:4D'),
  });

  const initiatorSession = new BluetoothPeerSession({
    link: initiator,
    handleRequest: async (request) => ({
      id: request.id,
      isOk: false,
      errorCode: 'unknown',
      errorMessage: 'initiator serves nothing in this test',
    }),
  });

  const connector: BluetoothPeerConnector = {
    isAvailable: async () => true,
    connectToAnyReachableMember: async () => initiatorSession,
    connectToDevice: async () => initiatorSession,
  };

  const credentialStore = createStatefulCredentialStore<
    typeof PROVIDER_ID_BLUETOOTH,
    BluetoothSyncPrivateCfg
  >({
    roomId: 'room-1',
    localDeviceId: 'local-device',
    localDeviceName: 'Laptop',
    members: localMembers,
  });

  const localReplicaAdapter = createInMemoryFileAdapter();
  const provider = new BluetoothSyncProvider({
    logger,
    connector,
    credentialStore,
    localReplica: localReplicaAdapter,
  });

  return {
    provider,
    credentialStore,
    remoteFiles: remoteAdapter.files,
    localReplicaFiles: localReplicaAdapter.files,
    readRemoteMembers: () => remoteRoomMembers,
    closeResponderLink: () => responder.close(),
  };
};

describe('BluetoothSyncProvider over a loopback link', () => {
  it('uploads a file and reports the content revision the peer computed', async () => {
    const { provider, remoteFiles } = createPairedPeers();

    const { rev } = await provider.uploadFile(SYNC_PATH, '{"ops":[]}', null);

    expect(remoteFiles.get(SYNC_PATH)).toBe('{"ops":[]}');
    expect(rev).toBe(await md5('{"ops":[]}'));
  });

  it('replicates every upload onto the copy this device serves back to peers', async () => {
    const { provider, remoteFiles, localReplicaFiles } = createPairedPeers();

    await provider.uploadFile(SYNC_PATH, '{"ops":["a"]}', null);

    expect(remoteFiles.get(SYNC_PATH)).toBe('{"ops":["a"]}');
    expect(localReplicaFiles.get(SYNC_PATH)).toBe('{"ops":["a"]}');
  });

  it('drops a removed file from the replica as well as the peer', async () => {
    const { provider, remoteFiles, localReplicaFiles } = createPairedPeers({
      remoteSeed: { [SYNC_PATH]: '{"ops":[]}' },
    });
    await provider.uploadFile(SYNC_PATH, '{"ops":["a"]}', null, true);

    await provider.removeFile(SYNC_PATH);

    expect(remoteFiles.has(SYNC_PATH)).toBe(false);
    expect(localReplicaFiles.has(SYNC_PATH)).toBe(false);
  });

  it('downloads what another device uploaded, across many link chunks', async () => {
    const largePayload = JSON.stringify({ ops: 'x'.repeat(50_000) });
    const { provider } = createPairedPeers({
      remoteSeed: { [SYNC_PATH]: largePayload },
      chunkBytes: 97,
    });

    const downloaded = await provider.downloadFile(SYNC_PATH);

    expect(downloaded.dataStr).toBe(largePayload);
    expect(downloaded.rev).toBe(await md5(largePayload));
  });

  it('reports a missing remote file as RemoteFileNotFoundAPIError', async () => {
    const { provider } = createPairedPeers();

    await expect(provider.downloadFile(SYNC_PATH)).rejects.toBeInstanceOf(
      RemoteFileNotFoundAPIError,
    );
  });

  it('rejects a create when the peer already holds the file', async () => {
    const { provider, remoteFiles } = createPairedPeers({
      remoteSeed: { [SYNC_PATH]: 'already here' },
    });

    await expect(provider.uploadFile(SYNC_PATH, 'newer', null)).rejects.toBeInstanceOf(
      UploadRevToMatchMismatchAPIError,
    );
    expect(remoteFiles.get(SYNC_PATH)).toBe('already here');
  });

  it('rejects an update whose revToMatch is stale and leaves the peer untouched', async () => {
    const { provider, remoteFiles } = createPairedPeers({
      remoteSeed: { [SYNC_PATH]: 'current' },
    });

    await expect(
      provider.uploadFile(SYNC_PATH, 'overwrite', await md5('stale')),
    ).rejects.toBeInstanceOf(UploadRevToMatchMismatchAPIError);
    expect(remoteFiles.get(SYNC_PATH)).toBe('current');
  });

  it('accepts an update whose revToMatch is the peer current revision', async () => {
    const { provider, remoteFiles } = createPairedPeers({
      remoteSeed: { [SYNC_PATH]: 'current' },
    });

    await provider.uploadFile(SYNC_PATH, 'next', await md5('current'));

    expect(remoteFiles.get(SYNC_PATH)).toBe('next');
  });

  it('lets exactly one of two concurrent compare-and-swap writers win', async () => {
    const { provider, remoteFiles } = createPairedPeers({
      remoteSeed: { [SYNC_PATH]: 'base' },
    });
    const baseRev = await md5('base');

    const outcomes = await Promise.allSettled([
      provider.uploadFile(SYNC_PATH, 'from-writer-a', baseRev),
      provider.uploadFile(SYNC_PATH, 'from-writer-b', baseRev),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(['from-writer-a', 'from-writer-b']).toContain(remoteFiles.get(SYNC_PATH));
  });

  it('force overwrite bypasses the revision check', async () => {
    const { provider, remoteFiles } = createPairedPeers({
      remoteSeed: { [SYNC_PATH]: 'current' },
    });

    await provider.uploadFile(SYNC_PATH, 'forced', await md5('stale'), true);

    expect(remoteFiles.get(SYNC_PATH)).toBe('forced');
  });

  it('removes a remote file and tolerates a repeated removal', async () => {
    const { provider, remoteFiles } = createPairedPeers({
      remoteSeed: { [SYNC_PATH]: 'doomed' },
    });

    await provider.removeFile(SYNC_PATH);
    await provider.removeFile(SYNC_PATH);

    expect(remoteFiles.has(SYNC_PATH)).toBe(false);
  });

  it('lists the files the peer holds under a prefix', async () => {
    const { provider } = createPairedPeers({
      remoteSeed: Object.fromEntries([
        ['room/a.json', 'a'],
        ['room/b.json', 'b'],
        ['other.json', 'c'],
      ]),
    });

    await expect(provider.listFiles('room/')).resolves.toEqual([
      'room/a.json',
      'room/b.json',
    ]);
  });

  it('refuses every file request from a device outside the room', async () => {
    const { provider, remoteFiles } = createPairedPeers({
      remoteSeed: { [SYNC_PATH]: 'private' },
      remoteMembers: [],
    });

    await expect(provider.downloadFile(SYNC_PATH)).rejects.toBeInstanceOf(
      BluetoothPeerError,
    );
    expect(remoteFiles.get(SYNC_PATH)).toBe('private');
  });

  it('learns a third device from a trusted peer during the handshake', async () => {
    const { provider, credentialStore } = createPairedPeers({
      localMembers: [remoteMember('remote-device', true)],
      remoteMembers: [remoteMember('local-device'), remoteMember('phone')],
    });

    await provider.uploadFile(SYNC_PATH, '{"ops":[]}', null);

    const cfg = await credentialStore.load();
    expect(cfg?.members?.map((entry) => entry.deviceId)).toEqual([
      'remote-device',
      'phone',
    ]);
    expect(cfg?.members?.[1].isTrustedToInvite).toBe(false);
    expect(cfg?.members?.[1].invitedByDeviceId).toBe('remote-device');
  });

  it('does not learn members from a peer this device has not trusted to invite', async () => {
    const { provider, credentialStore } = createPairedPeers({
      localMembers: [remoteMember('remote-device', false)],
      remoteMembers: [remoteMember('local-device'), remoteMember('phone')],
    });

    await provider.uploadFile(SYNC_PATH, '{"ops":[]}', null);

    const cfg = await credentialStore.load();
    expect(cfg?.members?.map((entry) => entry.deviceId)).toEqual(['remote-device']);
  });

  it('teaches a trusting peer about devices it does not know yet', async () => {
    const { provider, readRemoteMembers } = createPairedPeers({
      localMembers: [remoteMember('remote-device'), remoteMember('phone')],
      remoteMembers: [remoteMember('local-device', true)],
    });

    await provider.uploadFile(SYNC_PATH, '{"ops":[]}', null);

    expect(readRemoteMembers().map((entry) => entry.deviceId)).toEqual([
      'local-device',
      'phone',
    ]);
  });

  it('fails an in-flight request when the link drops', async () => {
    const { provider, closeResponderLink } = createPairedPeers({
      remoteSeed: { [SYNC_PATH]: 'x'.repeat(200_000) },
      chunkBytes: 8,
    });

    const pending = provider.downloadFile(SYNC_PATH);
    await closeResponderLink();

    await expect(pending).rejects.toThrow();
  });

  it('is not ready until a room with members is configured', async () => {
    const logger = createSilentSyncLogger();
    const provider = new BluetoothSyncProvider({
      logger,
      connector: {
        isAvailable: async () => true,
        connectToAnyReachableMember: async () => {
          throw new Error('not expected');
        },
        connectToDevice: async () => {
          throw new Error('not expected');
        },
      },
      credentialStore: createStatefulCredentialStore<
        typeof PROVIDER_ID_BLUETOOTH,
        BluetoothSyncPrivateCfg
      >({ roomId: 'room-1', localDeviceId: 'local-device', members: [] }),
      localReplica: createInMemoryFileAdapter(),
    });

    await expect(provider.isReady()).resolves.toBe(false);
  });
});
