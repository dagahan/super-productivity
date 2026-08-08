import { describe, expect, it } from 'vitest';
import {
  encodeFrame,
  FrameDecoder,
  FrameTooLargeError,
  FRAME_HEADER_BYTES,
  MAX_FRAME_PAYLOAD_BYTES,
} from '../src/bluetooth/frame-codec';

const payloadOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const textOf = (payload: Uint8Array): string => new TextDecoder().decode(payload);

describe('bluetooth frame codec', () => {
  it('round-trips a single frame', () => {
    const decoder = new FrameDecoder();
    const frames = decoder.push(encodeFrame({ type: 7, payload: payloadOf('hello') }));

    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe(7);
    expect(textOf(frames[0].payload)).toBe('hello');
    expect(decoder.bufferedBytes).toBe(0);
  });

  it('reassembles a frame split across arbitrary chunk boundaries', () => {
    const encoded = encodeFrame({ type: 1, payload: payloadOf('split me carefully') });
    const decoder = new FrameDecoder();

    const collected = [];
    for (let index = 0; index < encoded.length; index += 1) {
      collected.push(...decoder.push(encoded.slice(index, index + 1)));
    }

    expect(collected).toHaveLength(1);
    expect(textOf(collected[0].payload)).toBe('split me carefully');
  });

  it('emits every frame when several arrive in one chunk', () => {
    const first = encodeFrame({ type: 1, payload: payloadOf('one') });
    const second = encodeFrame({ type: 2, payload: payloadOf('two') });
    const merged = new Uint8Array(first.length + second.length);
    merged.set(first, 0);
    merged.set(second, first.length);

    const frames = new FrameDecoder().push(merged);

    expect(frames.map((frame) => textOf(frame.payload))).toEqual(['one', 'two']);
    expect(frames.map((frame) => frame.type)).toEqual([1, 2]);
  });

  it('keeps a trailing partial frame buffered instead of emitting it', () => {
    const encoded = encodeFrame({ type: 1, payload: payloadOf('incomplete') });
    const decoder = new FrameDecoder();

    const frames = decoder.push(encoded.slice(0, encoded.length - 2));

    expect(frames).toHaveLength(0);
    expect(decoder.bufferedBytes).toBe(encoded.length - 2);
  });

  it('handles an empty payload', () => {
    const frames = new FrameDecoder().push(
      encodeFrame({ type: 3, payload: new Uint8Array(0) }),
    );

    expect(frames).toHaveLength(1);
    expect(frames[0].payload).toHaveLength(0);
  });

  it('rejects an oversized payload on encode', () => {
    expect(() =>
      encodeFrame({ type: 1, payload: new Uint8Array(MAX_FRAME_PAYLOAD_BYTES + 1) }),
    ).toThrow(FrameTooLargeError);
  });

  it('rejects a declared length beyond the cap instead of allocating it', () => {
    const header = new Uint8Array(FRAME_HEADER_BYTES);
    new DataView(header.buffer).setUint32(0, MAX_FRAME_PAYLOAD_BYTES + 1, false);

    expect(() => new FrameDecoder().push(header)).toThrow(FrameTooLargeError);
  });
});
