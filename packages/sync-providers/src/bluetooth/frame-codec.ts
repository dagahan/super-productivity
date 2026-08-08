export const FRAME_HEADER_BYTES = 5;
export const MAX_FRAME_PAYLOAD_BYTES = 32 * 1024 * 1024;

export interface BluetoothFrame {
  type: number;
  payload: Uint8Array;
}

export class FrameTooLargeError extends Error {
  constructor(payloadBytes: number) {
    super(
      `Bluetooth frame payload of ${payloadBytes} bytes exceeds ${MAX_FRAME_PAYLOAD_BYTES}`,
    );
  }
}

export const encodeFrame = ({ type, payload }: BluetoothFrame): Uint8Array => {
  if (payload.length > MAX_FRAME_PAYLOAD_BYTES) {
    throw new FrameTooLargeError(payload.length);
  }
  const frame = new Uint8Array(FRAME_HEADER_BYTES + payload.length);
  const header = new DataView(frame.buffer, 0, FRAME_HEADER_BYTES);
  header.setUint32(0, payload.length, false);
  header.setUint8(4, type);
  frame.set(payload, FRAME_HEADER_BYTES);
  return frame;
};

export class FrameDecoder {
  private buffered: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): BluetoothFrame[] {
    this.buffered = concatChunks(this.buffered, chunk);
    const frames: BluetoothFrame[] = [];

    while (this.buffered.length >= FRAME_HEADER_BYTES) {
      const header = new DataView(
        this.buffered.buffer,
        this.buffered.byteOffset,
        FRAME_HEADER_BYTES,
      );
      const payloadBytes = header.getUint32(0, false);
      if (payloadBytes > MAX_FRAME_PAYLOAD_BYTES) {
        throw new FrameTooLargeError(payloadBytes);
      }
      const frameBytes = FRAME_HEADER_BYTES + payloadBytes;
      if (this.buffered.length < frameBytes) {
        break;
      }
      frames.push({
        type: header.getUint8(4),
        payload: this.buffered.slice(FRAME_HEADER_BYTES, frameBytes),
      });
      this.buffered = this.buffered.slice(frameBytes);
    }

    return frames;
  }

  get bufferedBytes(): number {
    return this.buffered.length;
  }
}

const concatChunks = (left: Uint8Array, right: Uint8Array): Uint8Array => {
  if (left.length === 0) {
    return right;
  }
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left, 0);
  merged.set(right, left.length);
  return merged;
};
