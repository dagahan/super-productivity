import { describe, expect, it } from 'vitest';
import {
  findMemberByAddress,
  isTrustedToInvite,
  mergeRoomMembers,
  normalizeDeviceAddress,
} from '../src/bluetooth/bluetooth-room';
import type { BluetoothRoomMember } from '../src/bluetooth/bluetooth.model';

const member = (
  deviceId: string,
  overrides: Partial<BluetoothRoomMember> = {},
): BluetoothRoomMember => ({
  deviceId,
  deviceName: `${deviceId} name`,
  platformAddress: `00:00:00:00:00:${deviceId.slice(-2)}`,
  isTrustedToInvite: false,
  invitedByDeviceId: null,
  ...overrides,
});

describe('bluetooth room membership', () => {
  it('learns members a trusted peer knows about', () => {
    const result = mergeRoomMembers({
      localDeviceId: 'laptop',
      localMembers: [member('tablet', { isTrustedToInvite: true })],
      peerDeviceId: 'tablet',
      peerMembers: [member('phone')],
    });

    expect(result.addedDeviceIds).toEqual(['phone']);
    expect(result.members.map((entry) => entry.deviceId)).toEqual(['tablet', 'phone']);
  });

  it('records who introduced a newly learned member', () => {
    const result = mergeRoomMembers({
      localDeviceId: 'laptop',
      localMembers: [member('tablet', { isTrustedToInvite: true })],
      peerDeviceId: 'tablet',
      peerMembers: [member('phone')],
    });

    expect(result.members[1].invitedByDeviceId).toBe('tablet');
  });

  it('never inherits the trust flag, so each device grants it separately', () => {
    const result = mergeRoomMembers({
      localDeviceId: 'laptop',
      localMembers: [member('tablet', { isTrustedToInvite: true })],
      peerDeviceId: 'tablet',
      peerMembers: [member('phone', { isTrustedToInvite: true })],
    });

    expect(result.members[1].isTrustedToInvite).toBe(false);
  });

  it('ignores everything an untrusted peer claims', () => {
    const localMembers = [member('tablet')];

    const result = mergeRoomMembers({
      localDeviceId: 'laptop',
      localMembers,
      peerDeviceId: 'tablet',
      peerMembers: [member('attacker')],
    });

    expect(result.addedDeviceIds).toEqual([]);
    expect(result.members).toBe(localMembers);
  });

  it('ignores a peer that is not a member at all', () => {
    const result = mergeRoomMembers({
      localDeviceId: 'laptop',
      localMembers: [member('tablet', { isTrustedToInvite: true })],
      peerDeviceId: 'stranger',
      peerMembers: [member('phone')],
    });

    expect(result.addedDeviceIds).toEqual([]);
  });

  it('never re-adds this device to its own member list', () => {
    const result = mergeRoomMembers({
      localDeviceId: 'laptop',
      localMembers: [member('tablet', { isTrustedToInvite: true })],
      peerDeviceId: 'tablet',
      peerMembers: [member('laptop'), member('phone')],
    });

    expect(result.members.map((entry) => entry.deviceId)).toEqual(['tablet', 'phone']);
  });

  it('keeps the local record when a peer reports an existing member differently', () => {
    const result = mergeRoomMembers({
      localDeviceId: 'laptop',
      localMembers: [
        member('tablet', { isTrustedToInvite: true }),
        member('phone', { isTrustedToInvite: true, deviceName: 'My Phone' }),
      ],
      peerDeviceId: 'tablet',
      peerMembers: [member('phone', { deviceName: 'Renamed', isTrustedToInvite: false })],
    });

    expect(result.addedDeviceIds).toEqual([]);
    expect(result.members[1].deviceName).toBe('My Phone');
    expect(result.members[1].isTrustedToInvite).toBe(true);
  });

  it('converges when three devices meet pairwise', () => {
    const laptopAfterTablet = mergeRoomMembers({
      localDeviceId: 'laptop',
      localMembers: [member('tablet', { isTrustedToInvite: true })],
      peerDeviceId: 'tablet',
      peerMembers: [member('laptop'), member('phone')],
    });

    const laptopAfterPhone = mergeRoomMembers({
      localDeviceId: 'laptop',
      localMembers: laptopAfterTablet.members,
      peerDeviceId: 'tablet',
      peerMembers: [member('phone'), member('watch')],
    });

    expect(laptopAfterPhone.members.map((entry) => entry.deviceId)).toEqual([
      'tablet',
      'phone',
      'watch',
    ]);
  });

  it('reports trust only for a member explicitly granted it', () => {
    const members = [member('tablet', { isTrustedToInvite: true }), member('phone')];

    expect(isTrustedToInvite(members, 'tablet')).toBe(true);
    expect(isTrustedToInvite(members, 'phone')).toBe(false);
    expect(isTrustedToInvite(members, 'stranger')).toBe(false);
  });

  it('treats the macOS and Android spellings of one address as the same device', () => {
    expect(normalizeDeviceAddress('44-cb-ad-5d-06-4d')).toBe(
      normalizeDeviceAddress('44:CB:AD:5D:06:4D'),
    );
  });

  it('finds a member however the platform spelled its address', () => {
    const members = [member('tablet', { platformAddress: '44:CB:AD:5D:06:4D' })];

    expect(findMemberByAddress(members, '44-cb-ad-5d-06-4d')?.deviceId).toBe('tablet');
    expect(findMemberByAddress(members, '00:00:00:00:00:00')).toBeUndefined();
  });
});
