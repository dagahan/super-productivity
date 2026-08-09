import {
  BluetoothLinkClosedError,
  BluetoothRequestTimeoutError,
  type BluetoothLink,
} from './bluetooth-link';
import {
  BLUETOOTH_FRAME_TYPE,
  decodeRequestMessage,
  decodeResponseMessage,
  encodeMessage,
  type BluetoothRequestMessage,
  type BluetoothResponseMessage,
} from './bluetooth-message';
import { encodeFrame, FrameDecoder } from './frame-codec';

export const DEFAULT_BLUETOOTH_REQUEST_TIMEOUT_MS = 120_000;

export type BluetoothRequestHandler = (
  request: BluetoothRequestMessage,
) => Promise<BluetoothResponseMessage>;

export interface BluetoothPeerSessionDeps {
  link: BluetoothLink;
  handleRequest: BluetoothRequestHandler;
  requestTimeoutMs?: number;
  onProgress?: (transferredBytes: number) => void;
}

interface PendingRequest {
  method: string;
  resolve: (response: BluetoothResponseMessage) => void;
  reject: (error: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

export class BluetoothPeerSession {
  private readonly decoder = new FrameDecoder();
  private readonly pendingByRequestId = new Map<string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private writeChain: Promise<void> = Promise.resolve();
  private nextRequestSequence = 0;
  private closeReason: string | null = null;
  private isClosed = false;

  constructor(private readonly deps: BluetoothPeerSessionDeps) {
    this.requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_BLUETOOTH_REQUEST_TIMEOUT_MS;
    deps.link.onData((chunk) => this.acceptChunk(chunk));
    deps.link.onClose((reason) => this.failAllPending(reason));
  }

  async send(request: BluetoothRequestMessage): Promise<unknown> {
    if (this.isClosed) {
      throw new BluetoothLinkClosedError(this.closeReason);
    }
    const response = await this.awaitResponse(request);
    if (!response.isOk) {
      throw new BluetoothPeerError(response.errorCode, response.errorMessage);
    }
    return response.result;
  }

  get isOpen(): boolean {
    return !this.isClosed;
  }

  createRequestId(): string {
    this.nextRequestSequence += 1;
    return `${this.nextRequestSequence}`;
  }

  async close(): Promise<void> {
    this.failAllPending(null);
    await this.deps.link.close();
  }

  private awaitResponse(
    request: BluetoothRequestMessage,
  ): Promise<BluetoothResponseMessage> {
    return new Promise<BluetoothResponseMessage>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingByRequestId.delete(request.id);
        reject(new BluetoothRequestTimeoutError(request.method, this.requestTimeoutMs));
      }, this.requestTimeoutMs);

      this.pendingByRequestId.set(request.id, {
        method: request.method,
        resolve,
        reject,
        timeoutHandle,
      });

      this.writeFrame(BLUETOOTH_FRAME_TYPE.request, request).catch((error: unknown) => {
        this.pendingByRequestId.delete(request.id);
        clearTimeout(timeoutHandle);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private writeFrame(type: number, message: unknown): Promise<void> {
    const frame = encodeFrame({ type, payload: encodeMessage(message) });
    const write = this.writeChain.then(() => this.deps.link.write(frame));
    this.writeChain = write.then(
      () => undefined,
      () => undefined,
    );
    return write;
  }

  private acceptChunk(chunk: Uint8Array): void {
    this.deps.onProgress?.(chunk.length);
    for (const frame of this.decoder.push(chunk)) {
      if (frame.type === BLUETOOTH_FRAME_TYPE.response) {
        this.resolvePending(decodeResponseMessage(frame.payload));
      } else if (frame.type === BLUETOOTH_FRAME_TYPE.request) {
        void this.serveRequest(decodeRequestMessage(frame.payload));
      }
    }
  }

  private resolvePending(response: BluetoothResponseMessage): void {
    const pending = this.pendingByRequestId.get(response.id);
    if (!pending) {
      return;
    }
    this.pendingByRequestId.delete(response.id);
    clearTimeout(pending.timeoutHandle);
    pending.resolve(response);
  }

  private async serveRequest(request: BluetoothRequestMessage): Promise<void> {
    let response: BluetoothResponseMessage;
    try {
      response = await this.deps.handleRequest(request);
    } catch (error) {
      response = {
        id: request.id,
        isOk: false,
        errorCode: 'unknown',
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
    await this.writeFrame(BLUETOOTH_FRAME_TYPE.response, response).catch(() => undefined);
  }

  private failAllPending(reason: string | null): void {
    this.isClosed = true;
    this.closeReason = reason;
    const closedError = new BluetoothLinkClosedError(reason);
    for (const pending of this.pendingByRequestId.values()) {
      clearTimeout(pending.timeoutHandle);
      pending.reject(closedError);
    }
    this.pendingByRequestId.clear();
  }
}

export class BluetoothPeerError extends Error {
  constructor(
    readonly errorCode: string,
    message: string,
  ) {
    super(message);
  }
}
