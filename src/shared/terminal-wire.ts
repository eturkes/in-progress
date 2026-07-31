export const TerminalWire = {
  input: 0x01,
  resize: 0x02,
  ping: 0x03,
  claim: 0x04,
  output: 0x81,
  snapshot: 0x82,
  status: 0x83,
  pong: 0x84,
} as const;

export function wireFrame(opcode: number, payload?: Uint8Array): Uint8Array {
  const frame = new Uint8Array(1 + (payload?.byteLength ?? 0));
  frame[0] = opcode;
  if (payload) frame.set(payload, 1);
  return frame;
}

export function resizeFrame(cols: number, rows: number): Uint8Array {
  const frame = new Uint8Array(5);
  const view = new DataView(frame.buffer);
  frame[0] = TerminalWire.resize;
  view.setUint16(1, cols);
  view.setUint16(3, rows);
  return frame;
}
