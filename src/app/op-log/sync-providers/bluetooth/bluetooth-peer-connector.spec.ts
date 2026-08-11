import type { BluetoothLink, BluetoothRoomMember } from '@sp/sync-providers/bluetooth';
import { OP_LOG_SYNC_LOGGER } from '../../core/sync-logger.adapter';
import { ReachableMemberConnector } from './bluetooth-peer-connector';
import type {
  BluetoothPairedDevice,
  BluetoothPlatformBridge,
} from './bluetooth-platform.port';

const member = (deviceId: string, platformAddress: string): BluetoothRoomMember => ({
  deviceId,
  deviceName: `${deviceId} name`,
  platformAddress,
  isTrustedToInvite: false,
  invitedByDeviceId: null,
});

const PIXEL = member('sp-pixel', '84:2F:57:52:C4:C6');
const REDMI = member('sp-redmi', '44:CB:AD:5D:06:4D');

const createLink = (peerDeviceId: string): BluetoothLink => ({
  kind: 'l2capChannel',
  peerDeviceId,
  write: async () => undefined,
  onData: () => undefined,
  onClose: () => undefined,
  close: async () => undefined,
});

const asPairedDevice = (roomMember: BluetoothRoomMember): BluetoothPairedDevice => ({
  platformAddress: roomMember.platformAddress,
  deviceName: roomMember.deviceName,
  isCurrentlyConnected: false,
});

const createConnector = ({
  members = [PIXEL, REDMI],
  paired = members.map(asPairedDevice),
  unreachableAddresses = [] as string[],
}: {
  members?: BluetoothRoomMember[];
  paired?: BluetoothPairedDevice[];
  unreachableAddresses?: string[];
} = {}): { connector: ReachableMemberConnector; dialledAddresses: string[] } => {
  const dialledAddresses: string[] = [];
  const bridge = {
    isAvailable: async () => true,
    listPairedDevices: async () => paired,
    connectToDevice: async (platformAddress: string): Promise<BluetoothLink> => {
      if (unreachableAddresses.includes(platformAddress)) {
        throw new Error(`${platformAddress} is out of range`);
      }
      dialledAddresses.push(platformAddress);
      return createLink(platformAddress);
    },
  } as unknown as BluetoothPlatformBridge;

  return {
    connector: new ReachableMemberConnector({
      bridge,
      logger: OP_LOG_SYNC_LOGGER,
      loadMembers: async () => members,
      createPeerHandler: () => async (request) => ({
        id: request.id,
        isOk: false,
        errorCode: 'unknown',
        errorMessage: 'not serving in this test',
      }),
    }),
    dialledAddresses,
  };
};

describe('ReachableMemberConnector', () => {
  it('gives the least recently reached member the next turn', async () => {
    const { connector, dialledAddresses } = createConnector();

    const first = await connector.connectToAnyReachableMember();
    await first.close();
    const second = await connector.connectToAnyReachableMember();
    await second.close();

    expect(dialledAddresses).toEqual([PIXEL.platformAddress, REDMI.platformAddress]);
  });

  it('prefers a member the platform already has a live connection to', async () => {
    const { connector, dialledAddresses } = createConnector({
      paired: [
        asPairedDevice(PIXEL),
        {
          platformAddress: REDMI.platformAddress,
          deviceName: REDMI.deviceName,
          isCurrentlyConnected: true,
        },
      ],
    });

    const session = await connector.connectToAnyReachableMember();
    await session.close();

    expect(dialledAddresses).toEqual([REDMI.platformAddress]);
  });

  it('matches the live connection whatever case the platform reports it in', async () => {
    const { connector, dialledAddresses } = createConnector({
      paired: [
        asPairedDevice(PIXEL),
        {
          platformAddress: REDMI.platformAddress.toLowerCase(),
          deviceName: REDMI.deviceName,
          isCurrentlyConnected: true,
        },
      ],
    });

    const session = await connector.connectToAnyReachableMember();
    await session.close();

    expect(dialledAddresses).toEqual([REDMI.platformAddress]);
  });

  it('moves on to the next member when the preferred one is out of range', async () => {
    const { connector, dialledAddresses } = createConnector({
      unreachableAddresses: [PIXEL.platformAddress],
    });

    const session = await connector.connectToAnyReachableMember();
    await session.close();

    expect(dialledAddresses).toEqual([REDMI.platformAddress]);
  });

  it('dials a member it only heard about by finding it in its own paired list', async () => {
    const { connector, dialledAddresses } = createConnector({
      members: [{ ...PIXEL, platformAddress: '' }],
      paired: [
        {
          platformAddress: PIXEL.platformAddress,
          deviceName: PIXEL.deviceName,
          isCurrentlyConnected: false,
        },
      ],
    });

    const session = await connector.connectToAnyReachableMember();
    await session.close();

    expect(dialledAddresses).toEqual([PIXEL.platformAddress]);
  });

  it('replaces an address this platform cannot dial rather than handing it over', async () => {
    const macOsIdentifier = '674CF748-4FE4-8684-4EFF-69B31D8DA165';
    const { connector, dialledAddresses } = createConnector({
      members: [{ ...PIXEL, platformAddress: macOsIdentifier }],
      paired: [
        {
          platformAddress: PIXEL.platformAddress,
          deviceName: PIXEL.deviceName,
          isCurrentlyConnected: false,
        },
      ],
    });

    const session = await connector.connectToAnyReachableMember();
    await session.close();

    expect(dialledAddresses).toEqual([PIXEL.platformAddress]);
  });

  it('says a member is unpaired here instead of dialling an address it cannot use', async () => {
    const { connector, dialledAddresses } = createConnector({
      members: [{ ...PIXEL, platformAddress: '674CF748-4FE4-8684-4EFF-69B31D8DA165' }],
      paired: [],
    });

    await expectAsync(connector.connectToAnyReachableMember()).toBeRejectedWithError(
      /not paired with this device yet/,
    );
    expect(dialledAddresses).toEqual([]);
  });

  it('reports every reason when no member could be reached', async () => {
    const { connector } = createConnector({
      unreachableAddresses: [PIXEL.platformAddress, REDMI.platformAddress],
    });

    await expectAsync(connector.connectToAnyReachableMember()).toBeRejectedWithError(
      /out of range/,
    );
  });
});
