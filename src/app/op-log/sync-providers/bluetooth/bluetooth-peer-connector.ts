import {
  BluetoothPeerSession,
  normalizeDeviceAddress,
  type BluetoothLink,
  type BluetoothPeerConnector,
  type BluetoothRequestHandler,
  type BluetoothRoomMember,
} from '@sp/sync-providers/bluetooth';
import type { SyncLogger } from '@sp/sync-core';
import type { BluetoothPlatformBridge } from './bluetooth-platform.port';

export interface ReachableMemberConnectorDeps {
  bridge: BluetoothPlatformBridge;
  logger: SyncLogger;
  loadMembers: () => Promise<BluetoothRoomMember[]>;
  createPeerHandler: (peerAddress: string) => BluetoothRequestHandler;
}

export class ReachableMemberConnector implements BluetoothPeerConnector {
  private readonly sessionsByPeer = new Map<string, BluetoothPeerSession>();
  private readonly reachedAtByPeer = new Map<string, number>();

  constructor(private readonly deps: ReachableMemberConnectorDeps) {}

  async isAvailable(): Promise<boolean> {
    return await this.deps.bridge.isAvailable();
  }

  // A peer that dialled us leaves an open channel behind, and the platforms
  // refuse a second channel on the same PSM between the same two devices. The
  // session is symmetric, so the side that answered reuses this one to sync back.
  adoptIncomingLink(link: BluetoothLink): void {
    this.rememberSession(link.peerDeviceId, this.startSession(link));
  }

  async connectToDevice(platformAddress: string): Promise<BluetoothPeerSession> {
    const openSession = this.findOpenSession(platformAddress);
    if (openSession) {
      return openSession;
    }
    const link = await this.deps.bridge.connectToDevice(platformAddress);
    const session = this.startSession(link);
    this.rememberSession(platformAddress, session);
    return session;
  }

  async connectToAnyReachableMember(): Promise<BluetoothPeerSession> {
    const members = await this.deps.loadMembers();
    if (!members.length) {
      throw new NoRoomMemberReachableError('the room has no other devices');
    }

    const failureReasons: string[] = [];
    for (const member of await this.orderByLikelyReachable(members)) {
      try {
        const session = await this.connectToDevice(member.platformAddress);
        this.reachedAtByPeer.set(
          normalizeDeviceAddress(member.platformAddress),
          Date.now(),
        );
        return session;
      } catch (error) {
        failureReasons.push(error instanceof Error ? error.message : String(error));
      }
    }

    this.deps.logger.normal('ReachableMemberConnector found no reachable member', {
      attemptedMemberCount: members.length,
    });
    throw new NoRoomMemberReachableError(failureReasons.join('; '));
  }

  private startSession(link: BluetoothLink): BluetoothPeerSession {
    return new BluetoothPeerSession({
      link,
      handleRequest: this.deps.createPeerHandler(link.peerDeviceId),
    });
  }

  private rememberSession(peerAddress: string, session: BluetoothPeerSession): void {
    this.sessionsByPeer.set(normalizeDeviceAddress(peerAddress), session);
  }

  private findOpenSession(peerAddress: string): BluetoothPeerSession | null {
    const key = normalizeDeviceAddress(peerAddress);
    const session = this.sessionsByPeer.get(key);
    if (!session) {
      return null;
    }
    if (session.isOpen) {
      return session;
    }
    this.sessionsByPeer.delete(key);
    return null;
  }

  private async orderByLikelyReachable(
    members: BluetoothRoomMember[],
  ): Promise<BluetoothRoomMember[]> {
    const paired = await this.deps.bridge.listPairedDevices();
    const connectedAddresses = new Set(
      paired
        .filter((device) => device.isCurrentlyConnected)
        .map((device) => normalizeDeviceAddress(device.platformAddress)),
    );
    const isConnected = (member: BluetoothRoomMember): number =>
      Number(connectedAddresses.has(normalizeDeviceAddress(member.platformAddress)));
    const reachedAt = (member: BluetoothRoomMember): number =>
      this.reachedAtByPeer.get(normalizeDeviceAddress(member.platformAddress)) ?? 0;

    return [...members].sort(
      (left, right) =>
        reachedAt(left) - reachedAt(right) || isConnected(right) - isConnected(left),
    );
  }
}

export class NoRoomMemberReachableError extends Error {
  constructor(detail: string) {
    super(`No Bluetooth room member could be reached: ${detail}`);
  }
}
