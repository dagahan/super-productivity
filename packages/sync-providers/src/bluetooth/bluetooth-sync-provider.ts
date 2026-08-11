import type { SyncLogger } from '@sp/sync-core';
import type { SyncCredentialStorePort } from '../credential-store-port';
import type { FileAdapter } from '../file-adapter';
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
  type InviteResult,
  type ListFilesResult,
} from './bluetooth-message';
import { BluetoothPeerError, type BluetoothPeerSession } from './bluetooth-peer-session';
import { mergeRoomMembers } from './bluetooth-room';
import {
  PROVIDER_ID_BLUETOOTH,
  type BluetoothRoomMember,
  type BluetoothSyncPrivateCfg,
} from './bluetooth.model';

export interface BluetoothPeerConnector {
  isAvailable(): Promise<boolean>;
  connectToAnyReachableMember(): Promise<BluetoothPeerSession>;
  connectToDevice(platformAddress: string): Promise<BluetoothPeerSession>;
}

export interface InvitationRequest {
  platformAddress: string;
  roomId: string;
  inviterDeviceId: string;
  inviterDeviceName: string;
  encryptKey: string | null;
}

export interface BluetoothSyncProviderDeps {
  logger: SyncLogger;
  connector: BluetoothPeerConnector;
  credentialStore: SyncCredentialStorePort<
    typeof PROVIDER_ID_BLUETOOTH,
    BluetoothSyncPrivateCfg
  >;
  // The room's sync file is replicated on every member: reads come from the peer,
  // writes land on the peer AND here, on the replica this device serves back. A
  // device that only wrote to its peer would read its own past uploads forever
  // and never see the peer's operations.
  localReplica: FileAdapter;
  peerPinIdleMs?: number;
}

export const DEFAULT_PEER_PIN_IDLE_MS = 45_000;

export class BluetoothSyncProvider implements FileSyncProvider<
  typeof PROVIDER_ID_BLUETOOTH,
  BluetoothSyncPrivateCfg
> {
  readonly id = PROVIDER_ID_BLUETOOTH;
  readonly isUploadForcePossible = true;
  readonly isConcurrentSnapshotMergeSafe = true;
  readonly maxConcurrentRequests = 1;

  privateCfg: SyncCredentialStorePort<
    typeof PROVIDER_ID_BLUETOOTH,
    BluetoothSyncPrivateCfg
  >;

  private activeSession: BluetoothPeerSession | null = null;
  private pinnedPeerDeviceId: string | null = null;
  private pinnedAt = 0;
  private readonly peerPinIdleMs: number;

  constructor(private readonly deps: BluetoothSyncProviderDeps) {
    this.privateCfg = deps.credentialStore;
    this.peerPinIdleMs = deps.peerPinIdleMs ?? DEFAULT_PEER_PIN_IDLE_MS;
  }

  async resolveSyncTargetKey(): Promise<string> {
    await this.openSession();
    return this.pinnedPeerDeviceId as string;
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
    await this.deps.localReplica.writeFile(targetPath, dataStr);
    return { rev: result.rev };
  }

  async removeFile(targetPath: string): Promise<void> {
    await this.request<null>((session) => ({
      id: session.createRequestId(),
      method: 'removeFile',
      targetPath,
    }));
    await this.deps.localReplica.deleteFile(targetPath).catch(() => undefined);
  }

  async listFiles(targetPath: string): Promise<string[]> {
    const result = await this.request<ListFilesResult>((session) => ({
      id: session.createRequestId(),
      method: 'listFiles',
      targetPath,
    }));
    return result.filePaths;
  }

  /**
   * Bootstraps a room with a device that is bonded but not yet a member. The
   * secret is only sent once the peer has answered, so a declined invitation
   * transmits nothing.
   */
  async invitePeer(invitation: InvitationRequest): Promise<InviteResult> {
    const session = await this.deps.connector.connectToDevice(invitation.platformAddress);
    try {
      const result = (await session.send({
        id: session.createRequestId(),
        method: 'invite',
        protocolVersion: BLUETOOTH_PROTOCOL_VERSION,
        roomId: invitation.roomId,
        inviterDeviceId: invitation.inviterDeviceId,
        inviterDeviceName: invitation.inviterDeviceName,
      })) as InviteResult;

      if (result.decision !== 'accepted') {
        return result;
      }

      await session.send({
        id: session.createRequestId(),
        method: 'roomSecret',
        encryptKey: invitation.encryptKey,
      });
      return result;
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  async disconnect(): Promise<void> {
    const session = this.activeSession;
    this.releasePeer();
    await session?.close();
  }

  private async request<TResult>(
    buildRequest: (
      session: BluetoothPeerSession,
    ) => Parameters<BluetoothPeerSession['send']>[0],
  ): Promise<TResult> {
    const session = await this.openSession();
    try {
      const result = (await session.send(buildRequest(session))) as TResult;
      this.pinnedAt = Date.now();
      return result;
    } catch (error) {
      this.activeSession = null;
      throw translatePeerError(error);
    }
  }

  private releasePeer(): void {
    this.activeSession = null;
    this.pinnedPeerDeviceId = null;
    this.pinnedAt = 0;
  }

  private shouldHandOverToAnotherMember(members: BluetoothRoomMember[]): boolean {
    return (
      this.pinnedPeerDeviceId !== null &&
      members.length > 1 &&
      Date.now() - this.pinnedAt >= this.peerPinIdleMs
    );
  }

  private async reconnectToPinnedPeer(
    members: BluetoothRoomMember[],
  ): Promise<BluetoothPeerSession | null> {
    const pinnedMember = members.find(
      (member) => member.deviceId === this.pinnedPeerDeviceId,
    );
    if (!pinnedMember) {
      return null;
    }
    try {
      return await this.deps.connector.connectToDevice(pinnedMember.platformAddress);
    } catch (error) {
      this.deps.logger.normal('BluetoothSyncProvider lost its pinned peer', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return null;
    }
  }

  private async openSession(): Promise<BluetoothPeerSession> {
    const cfg = await this.privateCfg.load();
    if (!cfg?.localDeviceId) {
      throw new InvalidDataSPError('Bluetooth sync has no local device id');
    }
    const localMembers = cfg.members ?? [];
    if (this.shouldHandOverToAnotherMember(localMembers)) {
      const idleSession = this.activeSession;
      this.releasePeer();
      await idleSession?.close().catch(() => undefined);
    }
    if (this.activeSession?.isOpen) {
      return this.activeSession;
    }
    this.activeSession = null;
    const session =
      (await this.reconnectToPinnedPeer(localMembers)) ??
      (await this.deps.connector.connectToAnyReachableMember());
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
      await this.privateCfg.upsertPartial({ members: merged.members });
    }

    this.deps.logger.normal('BluetoothSyncProvider connected', {
      peerProtocolVersion: hello.protocolVersion,
      learnedMemberCount: merged.addedDeviceIds.length,
    });
    this.activeSession = session;
    this.pinnedPeerDeviceId = hello.deviceId;
    this.pinnedAt = Date.now();
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
