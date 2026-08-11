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
      // Deliberately not the address the peer knows this member by. An address
      // is what one device observed, not a property of the member: macOS hands
      // out a CoreBluetooth identifier that is unique per host and per role,
      // while everyone else uses the classic MAC. Copying it across gives a
      // device an address it can never dial -- and asking Android to dial a
      // macOS identifier crashes the Bluetooth stack outright. Each device
      // learns the address itself, by matching a paired device or by noting
      // where this member turns up when it dials in.
      platformAddress: '',
      isTrustedToInvite: false,
      invitedByDeviceId: peerDeviceId,
    });
    addedDeviceIds.push(candidate.deviceId);
  }

  return { members, addedDeviceIds };
};
