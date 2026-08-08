export const BLUETOOTH_PROTOCOL_VERSION = 1;

export const BLUETOOTH_FRAME_TYPE = {
  request: 1,
  response: 2,
} as const;

export type BluetoothRequestMessage =
  | { id: string; method: 'hello'; protocolVersion: number; deviceId: string }
  | { id: string; method: 'getFileRev'; targetPath: string }
  | { id: string; method: 'downloadFile'; targetPath: string }
  | {
      id: string;
      method: 'uploadFile';
      targetPath: string;
      dataStr: string;
      revToMatch: string | null;
      isForceOverwrite: boolean;
    }
  | { id: string; method: 'removeFile'; targetPath: string }
  | { id: string; method: 'listFiles'; targetPath: string };

export type BluetoothRequestMethod = BluetoothRequestMessage['method'];

export type BluetoothErrorCode =
  | 'remoteFileNotFound'
  | 'revToMatchMismatch'
  | 'invalidData'
  | 'unsupportedProtocolVersion'
  | 'notAuthorized'
  | 'unknown';

export type BluetoothResponseMessage =
  | { id: string; isOk: true; result: unknown }
  | {
      id: string;
      isOk: false;
      errorCode: BluetoothErrorCode;
      errorMessage: string;
    };

export interface HelloResult {
  protocolVersion: number;
  deviceId: string;
}

export interface FileRevResult {
  rev: string;
}

export interface FileDownloadResult {
  rev: string;
  dataStr: string;
}

export interface ListFilesResult {
  filePaths: string[];
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const encodeMessage = (message: unknown): Uint8Array =>
  textEncoder.encode(JSON.stringify(message));

export const decodeRequestMessage = (payload: Uint8Array): BluetoothRequestMessage =>
  JSON.parse(textDecoder.decode(payload)) as BluetoothRequestMessage;

export const decodeResponseMessage = (payload: Uint8Array): BluetoothResponseMessage =>
  JSON.parse(textDecoder.decode(payload)) as BluetoothResponseMessage;
