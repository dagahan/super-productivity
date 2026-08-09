import type { BluetoothRoomMember } from './bluetooth.model';

export interface RoomMemberMergeInput {
  localDeviceId: string;
  localMembers: BluetoothRoomMember[];
  peerDeviceId: string;
  peerMembers: BluetoothRoomMember[];
}

export interface RoomMemberMergeResult {
  members: BluetoothRoomMember[];
  addedDeviceIds: string[];
}

/** Platforms spell the same address differently: macOS uses hyphens and
 * lowercase, Android uses colons and uppercase. */
export const normalizeDeviceAddress = (address: string): string =>
  address.replace(/[^0-9a-zA-Z]/g, '').toLowerCase();

export const isRoomMember = (members: BluetoothRoomMember[], deviceId: string): boolean =>
  members.some((member) => member.deviceId === deviceId);

export const findMemberByAddress = (
  members: BluetoothRoomMember[],
  platformAddress: string,
): BluetoothRoomMember | undefined => {
  const wanted = normalizeDeviceAddress(platformAddress);
  return members.find(
    (member) => normalizeDeviceAddress(member.platformAddress) === wanted,
  );
};

export const isTrustedToInvite = (
  members: BluetoothRoomMember[],
  deviceId: string,
): boolean =>
  members.some((member) => member.deviceId === deviceId && member.isTrustedToInvite);

export const mergeRoomMembers = ({
  localDeviceId,
  localMembers,
  peerDeviceId,
  peerMembers,
}: RoomMemberMergeInput): RoomMemberMergeResult => {
  if (!isTrustedToInvite(localMembers, peerDeviceId)) {
    return { members: localMembers, addedDeviceIds: [] };
  }

  const members = [...localMembers];
  const addedDeviceIds: string[] = [];

  for (const candidate of peerMembers) {
    if (
      candidate.deviceId === localDeviceId ||
      isRoomMember(members, candidate.deviceId)
    ) {
      continue;
    }
    members.push({
      deviceId: candidate.deviceId,
      deviceName: candidate.deviceName,
      platformAddress: candidate.platformAddress,
      isTrustedToInvite: false,
      invitedByDeviceId: peerDeviceId,
    });
    addedDeviceIds.push(candidate.deviceId);
  }

  return { members, addedDeviceIds };
};
