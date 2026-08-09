import type { SyncLogger } from '@sp/sync-core';
import type { FileAdapter } from '../file-adapter';
import { computeContentRev } from '../file-based/content-rev';
import {
  BLUETOOTH_PROTOCOL_VERSION,
  type BluetoothErrorCode,
  type BluetoothRequestMessage,
  type BluetoothResponseMessage,
} from './bluetooth-message';
import type { BluetoothRequestHandler } from './bluetooth-peer-session';
import {
  findMemberByAddress,
  mergeRoomMembers,
  normalizeDeviceAddress,
} from './bluetooth-room';
import type { BluetoothRoomMember } from './bluetooth.model';

export interface BluetoothRoomStore {
  loadLocalDeviceId(): Promise<string>;
  loadMembers(): Promise<BluetoothRoomMember[]>;
  saveMembers(members: BluetoothRoomMember[]): Promise<void>;
}

export interface BluetoothFileResponderDeps {
  fileAdapter: FileAdapter;
  logger: SyncLogger;
  room: BluetoothRoomStore;
}

export class BluetoothFileResponder {
  private readonly writeQueueByPath = new Map<string, Promise<unknown>>();
  private readonly authorizedPeerAddresses = new Set<string>();

  constructor(private readonly deps: BluetoothFileResponderDeps) {}

  /**
   * A peer is identified by the address of the link it connected over, which
   * the Bluetooth bond authenticates, never by the id it claims in its hello.
   */
  createPeerHandler(peerAddress: string): BluetoothRequestHandler {
    return (request) => this.handleRequestFromPeer(peerAddress, request);
  }

  private handleRequestFromPeer = async (
    peerAddress: string,
    request: BluetoothRequestMessage,
  ): Promise<BluetoothResponseMessage> => {
    try {
      if (request.method === 'hello') {
        return await this.respondToHello(peerAddress, request);
      }
      if (!this.authorizedPeerAddresses.has(normalizeDeviceAddress(peerAddress))) {
        return failure(request.id, 'notAuthorized', 'Peer did not complete handshake');
      }
      return await this.respondToFileRequest(request);
    } catch (error) {
      const errorCode = classifyError(error);
      if (errorCode === 'unknown') {
        this.deps.logger.critical('BluetoothFileResponder request failed', {
          method: request.method,
        });
      }
      return failure(request.id, errorCode, messageOf(error));
    }
  };

  private async respondToHello(
    peerAddress: string,
    request: Extract<BluetoothRequestMessage, { method: 'hello' }>,
  ): Promise<BluetoothResponseMessage> {
    if (request.protocolVersion !== BLUETOOTH_PROTOCOL_VERSION) {
      return failure(
        request.id,
        'unsupportedProtocolVersion',
        `Peer speaks protocol ${request.protocolVersion}, this device speaks ${BLUETOOTH_PROTOCOL_VERSION}`,
      );
    }
    const localDeviceId = await this.deps.room.loadLocalDeviceId();
    const localMembers = await this.deps.room.loadMembers();
    const peerMember = findMemberByAddress(localMembers, peerAddress);
    if (!peerMember) {
      return failure(request.id, 'notAuthorized', 'Peer is not a member of this room');
    }

    const merged = mergeRoomMembers({
      localDeviceId,
      localMembers,
      peerDeviceId: peerMember.deviceId,
      peerMembers: request.members,
    });
    if (merged.addedDeviceIds.length) {
      await this.deps.room.saveMembers(merged.members);
    }

    this.authorizedPeerAddresses.add(normalizeDeviceAddress(peerAddress));
    return {
      id: request.id,
      isOk: true,
      result: {
        protocolVersion: BLUETOOTH_PROTOCOL_VERSION,
        deviceId: localDeviceId,
        members: merged.members,
      },
    };
  }

  private async respondToFileRequest(
    request: Exclude<BluetoothRequestMessage, { method: 'hello' }>,
  ): Promise<BluetoothResponseMessage> {
    switch (request.method) {
      case 'getFileRev': {
        const { rev } = await this.readExistingFile(request.targetPath);
        return { id: request.id, isOk: true, result: { rev } };
      }
      case 'downloadFile': {
        const existing = await this.readExistingFile(request.targetPath);
        return { id: request.id, isOk: true, result: existing };
      }
      case 'uploadFile':
        return await this.runExclusivelyForPath(request.targetPath, async () => {
          const rev = await this.commitUpload(request);
          return { id: request.id, isOk: true, result: { rev } };
        });
      case 'removeFile':
        return await this.runExclusivelyForPath(request.targetPath, async () => {
          await this.deps.fileAdapter.deleteFile(request.targetPath);
          return { id: request.id, isOk: true, result: null };
        });
      case 'listFiles': {
        if (!this.deps.fileAdapter.listFiles) {
          return failure(request.id, 'unknown', 'FileAdapter does not support listFiles');
        }
        const filePaths = await this.deps.fileAdapter.listFiles(request.targetPath);
        return { id: request.id, isOk: true, result: { filePaths } };
      }
    }
  }

  private async commitUpload(
    request: Extract<BluetoothRequestMessage, { method: 'uploadFile' }>,
  ): Promise<string> {
    if (!request.isForceOverwrite) {
      const currentRev = await this.readCurrentRevOrNull(request.targetPath);
      if (currentRev !== request.revToMatch) {
        throw new RevToMatchMismatchError();
      }
    }
    await this.deps.fileAdapter.writeFile(request.targetPath, request.dataStr);
    return await computeContentRev(request.dataStr);
  }

  private async readCurrentRevOrNull(targetPath: string): Promise<string | null> {
    try {
      const { rev } = await this.readExistingFile(targetPath);
      return rev;
    } catch (error) {
      if (error instanceof FileNotFoundOnPeerError) {
        return null;
      }
      throw error;
    }
  }

  private async readExistingFile(
    targetPath: string,
  ): Promise<{ rev: string; dataStr: string }> {
    let dataStr: string;
    try {
      dataStr = await this.deps.fileAdapter.readFile(targetPath);
    } catch {
      throw new FileNotFoundOnPeerError(targetPath);
    }
    if (!dataStr) {
      throw new FileNotFoundOnPeerError(targetPath);
    }
    return { rev: await computeContentRev(dataStr), dataStr };
  }

  private runExclusivelyForPath<T>(
    targetPath: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = this.writeQueueByPath.get(targetPath) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.writeQueueByPath.set(
      targetPath,
      next.catch(() => undefined),
    );
    return next;
  }
}

export class FileNotFoundOnPeerError extends Error {
  constructor(targetPath: string) {
    super(`Peer has no file at ${targetPath}`);
  }
}

export class RevToMatchMismatchError extends Error {
  constructor() {
    super('Peer file revision does not match revToMatch');
  }
}

const failure = (
  id: string,
  errorCode: BluetoothErrorCode,
  errorMessage: string,
): BluetoothResponseMessage => ({ id, isOk: false, errorCode, errorMessage });

const classifyError = (error: unknown): BluetoothErrorCode => {
  if (error instanceof FileNotFoundOnPeerError) {
    return 'remoteFileNotFound';
  }
  if (error instanceof RevToMatchMismatchError) {
    return 'revToMatchMismatch';
  }
  return 'unknown';
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
