import { describe, expect, it, vi, type Mock } from 'vitest';
import type { BluetoothRequestHandler } from '../src/bluetooth/bluetooth-peer-session';
import {
  BluetoothFileResponder,
  type IncomingInvitation,
  type InvitationOutcome,
} from '../src/bluetooth/bluetooth-file-responder';
import { BLUETOOTH_PROTOCOL_VERSION } from '../src/bluetooth/bluetooth-message';
import type { BluetoothRoomMember } from '../src/bluetooth/bluetooth.model';
import {
  createInMemoryFileAdapter,
  createSilentSyncLogger,
} from './helpers/bluetooth-loopback';

const INVITER_ADDRESS = '84:2F:57:52:C4:C6';

const createResponder = ({
  isPeerBonded = true,
  outcome = { decision: 'accepted', isTrustedToInvite: false } as InvitationOutcome,
  members = [] as BluetoothRoomMember[],
}: {
  isPeerBonded?: boolean;
  outcome?: InvitationOutcome;
  members?: BluetoothRoomMember[];
} = {}): {
  handle: BluetoothRequestHandler;
  askUserAboutInvitation: Mock<
    (invitation: IncomingInvitation) => Promise<InvitationOutcome>
  >;
  readMembers: () => BluetoothRoomMember[];
  readSecrets: () => { roomId: string; encryptKey: string | null }[];
} => {
  let savedMembers = members;
  const savedSecrets: { roomId: string; encryptKey: string | null }[] = [];
  const askUserAboutInvitation = vi.fn(
    async (_invitation: IncomingInvitation) => outcome,
  );

  const responder = new BluetoothFileResponder({
    fileAdapter: createInMemoryFileAdapter(),
    logger: createSilentSyncLogger(),
    isPeerBonded: async () => isPeerBonded,
    askUserAboutInvitation,
    room: {
      loadLocalDeviceId: async () => 'this-device',
      loadLocalDeviceName: async () => 'Redmi Pad 2 Pro',
      loadMembers: async () => savedMembers,
      saveMembers: async (next) => {
        savedMembers = next;
      },
      saveRoomSecret: async (roomId, encryptKey) => {
        savedSecrets.push({ roomId, encryptKey });
      },
    },
  });

  return {
    handle: responder.createPeerHandler(INVITER_ADDRESS),
    askUserAboutInvitation,
    readMembers: () => savedMembers,
    readSecrets: () => savedSecrets,
  };
};

const inviteRequest = {
  id: '1',
  method: 'invite' as const,
  protocolVersion: BLUETOOTH_PROTOCOL_VERSION,
  roomId: 'room-1',
  inviterDeviceId: 'sp-mac',
  inviterDeviceName: "nick's MacBook Pro",
};

describe('bluetooth invitation gate', () => {
  it('asks the user and adds the inviter as a member when accepted', async () => {
    const peers = createResponder();

    const response = await peers.handle(inviteRequest);

    expect(peers.askUserAboutInvitation).toHaveBeenCalledTimes(1);
    expect(response.isOk).toBe(true);
    expect(peers.readMembers().map((entry) => entry.deviceId)).toEqual(['sp-mac']);
  });

  it('carries the invite right the user granted in the dialog', async () => {
    const peers = createResponder({
      outcome: { decision: 'accepted', isTrustedToInvite: true },
    });

    await peers.handle(inviteRequest);

    expect(peers.readMembers()[0].isTrustedToInvite).toBe(true);
  });

  it('refuses a device that is not bonded, without asking the user', async () => {
    const peers = createResponder({ isPeerBonded: false });

    const response = await peers.handle(inviteRequest);

    expect(peers.askUserAboutInvitation).not.toHaveBeenCalled();
    expect(response.isOk).toBe(false);
    expect(peers.readMembers()).toEqual([]);
  });

  it('adds nobody when the user rejects', async () => {
    const peers = createResponder({
      outcome: { decision: 'rejected', isTrustedToInvite: false },
    });

    const response = await peers.handle(inviteRequest);

    expect(response.isOk).toBe(false);
    expect(peers.readMembers()).toEqual([]);
  });

  it('does not re-prompt during the cooldown after a rejection', async () => {
    const peers = createResponder({
      outcome: { decision: 'rejected', isTrustedToInvite: false },
    });

    await peers.handle(inviteRequest);
    await peers.handle({ ...inviteRequest, id: '2' });

    expect(peers.askUserAboutInvitation).toHaveBeenCalledTimes(1);
  });

  it('stores the room secret only after an accepted invitation', async () => {
    const peers = createResponder();

    await peers.handle(inviteRequest);
    const response = await peers.handle({
      id: '2',
      method: 'roomSecret',
      encryptKey: 'the-key',
    });

    expect(response.isOk).toBe(true);
    expect(peers.readSecrets()).toEqual([{ roomId: 'room-1', encryptKey: 'the-key' }]);
  });

  it('refuses a room secret that no accepted invitation preceded', async () => {
    const peers = createResponder();

    const response = await peers.handle({
      id: '1',
      method: 'roomSecret',
      encryptKey: 'the-key',
    });

    expect(response.isOk).toBe(false);
    expect(peers.readSecrets()).toEqual([]);
  });

  it('still refuses file requests from a device that never completed an invitation', async () => {
    const peers = createResponder();

    const response = await peers.handle({
      id: '1',
      method: 'downloadFile',
      targetPath: 'sp-sync.json',
    });

    expect(response.isOk).toBe(false);
  });
});
