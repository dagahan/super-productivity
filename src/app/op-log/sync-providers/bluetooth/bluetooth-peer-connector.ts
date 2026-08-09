import {
  BluetoothPeerSession,
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
  constructor(private readonly deps: ReachableMemberConnectorDeps) {}

  async isAvailable(): Promise<boolean> {
    return await this.deps.bridge.isAvailable();
  }

  async connectToDevice(platformAddress: string): Promise<BluetoothPeerSession> {
    const link = await this.deps.bridge.connectToDevice(platformAddress);
    return new BluetoothPeerSession({
      link,
      handleRequest: this.deps.createPeerHandler(platformAddress),
    });
  }

  async connectToAnyReachableMember(): Promise<BluetoothPeerSession> {
    const members = await this.deps.loadMembers();
    if (!members.length) {
      throw new NoRoomMemberReachableError('the room has no other devices');
    }

    const failureReasons: string[] = [];
    for (const member of await this.orderByLikelyReachable(members)) {
      try {
        const link = await this.deps.bridge.connectToDevice(member.platformAddress);
        return new BluetoothPeerSession({
          link,
          handleRequest: this.deps.createPeerHandler(member.platformAddress),
        });
      } catch (error) {
        failureReasons.push(error instanceof Error ? error.message : String(error));
      }
    }

    this.deps.logger.normal('ReachableMemberConnector found no reachable member', {
      attemptedMemberCount: members.length,
    });
    throw new NoRoomMemberReachableError(failureReasons.join('; '));
  }

  private async orderByLikelyReachable(
    members: BluetoothRoomMember[],
  ): Promise<BluetoothRoomMember[]> {
    const paired = await this.deps.bridge.listPairedDevices();
    const connectedAddresses = new Set(
      paired
        .filter((device) => device.isCurrentlyConnected)
        .map((device) => device.platformAddress),
    );
    return [...members].sort(
      (left, right) =>
        Number(connectedAddresses.has(right.platformAddress)) -
        Number(connectedAddresses.has(left.platformAddress)),
    );
  }
}

export class NoRoomMemberReachableError extends Error {
  constructor(detail: string) {
    super(`No Bluetooth room member could be reached: ${detail}`);
  }
}
