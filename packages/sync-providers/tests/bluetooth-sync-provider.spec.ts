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
  type BluetoothSyncPrivateCfg,
} from '../src/bluetooth/bluetooth.model';
import { createStatefulCredentialStore } from './helpers/credential-store';
import {
  createInMemoryFileAdapter,
  createLinkPair,
  createSilentSyncLogger,
} from './helpers/bluetooth-loopback';

const SYNC_PATH = 'sp-sync.json';

interface PairedPeers {
  provider: BluetoothSyncProvider;
  remoteFiles: Map<string, string>;
  closeResponderLink: () => Promise<void>;
}

const createPairedPeers = ({
  remoteSeed = {},
  authorizedDeviceIds = ['local-device'],
  chunkBytes = 64,
}: {
  remoteSeed?: Record<string, string>;
  authorizedDeviceIds?: string[];
  chunkBytes?: number;
} = {}): PairedPeers => {
  const logger = createSilentSyncLogger();
  const { initiator, responder } = createLinkPair(chunkBytes);
  const remoteAdapter = createInMemoryFileAdapter(remoteSeed);

  const fileResponder = new BluetoothFileResponder({
    fileAdapter: remoteAdapter,
    logger,
    localDeviceId: 'remote-device',
    isPeerAuthorized: async (peerDeviceId) => authorizedDeviceIds.includes(peerDeviceId),
  });

  new BluetoothPeerSession({
    link: responder,
    handleRequest: fileResponder.handleRequest,
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
  };

  const provider = new BluetoothSyncProvider({
    logger,
    connector,
    credentialStore: createStatefulCredentialStore<
      typeof PROVIDER_ID_BLUETOOTH,
      BluetoothSyncPrivateCfg
    >({
      roomId: 'room-1',
      localDeviceId: 'local-device',
      localDeviceName: 'Laptop',
      members: [
        {
          deviceId: 'remote-device',
          deviceName: 'Tablet',
          platformAddress: '44:CB:AD:5D:06:4D',
          isTrustedToInvite: true,
          invitedByDeviceId: null,
        },
      ],
    }),
  });

  return {
    provider,
    remoteFiles: remoteAdapter.files,
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
      authorizedDeviceIds: [],
    });

    await expect(provider.downloadFile(SYNC_PATH)).rejects.toBeInstanceOf(
      BluetoothPeerError,
    );
    expect(remoteFiles.get(SYNC_PATH)).toBe('private');
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
      },
      credentialStore: createStatefulCredentialStore<
        typeof PROVIDER_ID_BLUETOOTH,
        BluetoothSyncPrivateCfg
      >({ roomId: 'room-1', localDeviceId: 'local-device', members: [] }),
    });

    await expect(provider.isReady()).resolves.toBe(false);
  });
});
