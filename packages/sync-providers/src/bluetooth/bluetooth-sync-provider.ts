import type { SyncLogger } from '@sp/sync-core';
import type { SyncCredentialStorePort } from '../credential-store-port';
import {
  InvalidDataSPError,
  RemoteFileNotFoundAPIError,
  UploadRevToMatchMismatchAPIError,
} from '../errors';
import type {
  FileDownloadResponse,
  FileRevResponse,
  FileSyncProvider,
} from '../provider-types';
import {
  BLUETOOTH_PROTOCOL_VERSION,
  type FileDownloadResult,
  type FileRevResult,
  type HelloResult,
  type ListFilesResult,
} from './bluetooth-message';
import { BluetoothPeerError, type BluetoothPeerSession } from './bluetooth-peer-session';
import { mergeRoomMembers } from './bluetooth-room';
import { PROVIDER_ID_BLUETOOTH, type BluetoothSyncPrivateCfg } from './bluetooth.model';

export interface BluetoothPeerConnector {
  isAvailable(): Promise<boolean>;
  connectToAnyReachableMember(): Promise<BluetoothPeerSession>;
}

export interface BluetoothSyncProviderDeps {
  logger: SyncLogger;
  connector: BluetoothPeerConnector;
  credentialStore: SyncCredentialStorePort<
    typeof PROVIDER_ID_BLUETOOTH,
    BluetoothSyncPrivateCfg
  >;
}

export class BluetoothSyncProvider implements FileSyncProvider<
  typeof PROVIDER_ID_BLUETOOTH,
  BluetoothSyncPrivateCfg
> {
  readonly id = PROVIDER_ID_BLUETOOTH;
  readonly isUploadForcePossible = true;
  readonly maxConcurrentRequests = 1;

  privateCfg: SyncCredentialStorePort<
    typeof PROVIDER_ID_BLUETOOTH,
    BluetoothSyncPrivateCfg
  >;

  private activeSession: BluetoothPeerSession | null = null;

  constructor(private readonly deps: BluetoothSyncProviderDeps) {
    this.privateCfg = deps.credentialStore;
  }

  async isReady(): Promise<boolean> {
    const cfg = await this.privateCfg.load();
    if (!cfg?.roomId || !cfg.localDeviceId || !cfg.members?.length) {
      return false;
    }
    return await this.deps.connector.isAvailable();
  }

  async setPrivateCfg(privateCfg: BluetoothSyncPrivateCfg): Promise<void> {
    await this.privateCfg.setComplete(privateCfg);
  }

  async getFileRev(
    targetPath: string,
    _localRev: string | null,
  ): Promise<FileRevResponse> {
    const result = await this.request<FileRevResult>((session) => ({
      id: session.createRequestId(),
      method: 'getFileRev',
      targetPath,
    }));
    return { rev: result.rev };
  }

  async downloadFile(targetPath: string): Promise<FileDownloadResponse> {
    const result = await this.request<FileDownloadResult>((session) => ({
      id: session.createRequestId(),
      method: 'downloadFile',
      targetPath,
    }));
    if (!result.dataStr || result.dataStr.length <= 3) {
      throw new InvalidDataSPError(
        `File content too short: ${result.dataStr?.length ?? 0} chars`,
      );
    }
    return { rev: result.rev, dataStr: result.dataStr };
  }

  async uploadFile(
    targetPath: string,
    dataStr: string,
    revToMatch: string | null,
    isForceOverwrite = false,
  ): Promise<FileRevResponse> {
    const result = await this.request<FileRevResult>((session) => ({
      id: session.createRequestId(),
      method: 'uploadFile',
      targetPath,
      dataStr,
      revToMatch,
      isForceOverwrite,
    }));
    return { rev: result.rev };
  }

  async removeFile(targetPath: string): Promise<void> {
    await this.request<null>((session) => ({
      id: session.createRequestId(),
      method: 'removeFile',
      targetPath,
    }));
  }

  async listFiles(targetPath: string): Promise<string[]> {
    const result = await this.request<ListFilesResult>((session) => ({
      id: session.createRequestId(),
      method: 'listFiles',
      targetPath,
    }));
    return result.filePaths;
  }

  async disconnect(): Promise<void> {
    const session = this.activeSession;
    this.activeSession = null;
    await session?.close();
  }

  private async request<TResult>(
    buildRequest: (
      session: BluetoothPeerSession,
    ) => Parameters<BluetoothPeerSession['send']>[0],
  ): Promise<TResult> {
    const session = await this.openSession();
    try {
      return (await session.send(buildRequest(session))) as TResult;
    } catch (error) {
      this.activeSession = null;
      throw translatePeerError(error);
    }
  }

  private async openSession(): Promise<BluetoothPeerSession> {
    if (this.activeSession) {
      return this.activeSession;
    }
    const cfg = await this.privateCfg.load();
    if (!cfg?.localDeviceId) {
      throw new InvalidDataSPError('Bluetooth sync has no local device id');
    }
    const localMembers = cfg.members ?? [];
    const session = await this.deps.connector.connectToAnyReachableMember();
    const hello = (await session.send({
      id: session.createRequestId(),
      method: 'hello',
      protocolVersion: BLUETOOTH_PROTOCOL_VERSION,
      deviceId: cfg.localDeviceId,
      members: localMembers,
    })) as HelloResult;

    const merged = mergeRoomMembers({
      localDeviceId: cfg.localDeviceId,
      localMembers,
      peerDeviceId: hello.deviceId,
      peerMembers: hello.members ?? [],
    });
    if (merged.addedDeviceIds.length) {
      await this.privateCfg.updatePartial({ members: merged.members });
    }

    this.deps.logger.normal('BluetoothSyncProvider connected', {
      peerProtocolVersion: hello.protocolVersion,
      learnedMemberCount: merged.addedDeviceIds.length,
    });
    this.activeSession = session;
    return session;
  }
}

const translatePeerError = (error: unknown): unknown => {
  if (!(error instanceof BluetoothPeerError)) {
    return error;
  }
  switch (error.errorCode) {
    case 'remoteFileNotFound':
      return new RemoteFileNotFoundAPIError(error.message);
    case 'revToMatchMismatch':
      return new UploadRevToMatchMismatchAPIError();
    case 'invalidData':
      return new InvalidDataSPError(error.message);
    default:
      return error;
  }
};
