import { createHash } from 'node:crypto';
import { MAX_FRAME_BYTES, ProtocolError } from '../shared/protocol.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > MAX_FRAME_BYTES) throw new ProtocolError('FRAME_TOO_LARGE', 'Outgoing WebSocket frame exceeds limit');
  let header;
  if (body.length < 126) { header = Buffer.alloc(2); header[1] = body.length; }
  else if (body.length <= 0xffff) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(body.length, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(body.length), 2); }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}
export function websocketAccept(key) { return createHash('sha1').update(`${key}${WS_GUID}`).digest('base64'); }
export function acceptUpgrade(req, socket, head = Buffer.alloc(0)) {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || req.headers['sec-websocket-version'] !== '13') throw new ProtocolError('BAD_WEBSOCKET', 'Invalid WebSocket upgrade');
  socket.write(['HTTP/1.1 101 Switching Protocols','Upgrade: websocket','Connection: Upgrade',`Sec-WebSocket-Accept: ${websocketAccept(key)}`,'\r\n'].join('\r\n'));
  return new RawWebSocket(socket, head);
}
export class RawWebSocket {
  constructor(socket, head = Buffer.alloc(0)) {
    this.socket = socket; this.buffer = head.length ? Buffer.from(head) : Buffer.alloc(0); this.closed = false; this.fragments = []; this.fragmentOpcode = null; this.messageHandlers = new Set(); this.closeHandlers = new Set(); this.lastPongAt = Date.now();
    socket.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); try { this.#drain(); } catch (error) { this.close(1002, error instanceof Error ? error.message : 'Protocol error'); } });
    socket.on('close', () => this.#markClosed()); socket.on('error', () => this.#markClosed());
    if (this.buffer.length) queueMicrotask(() => { try { this.#drain(); } catch { this.close(1002, 'Protocol error'); } });
  }
  onMessage(handler) { this.messageHandlers.add(handler); return () => this.messageHandlers.delete(handler); }
  onClose(handler) { this.closeHandlers.add(handler); return () => this.closeHandlers.delete(handler); }
  sendJson(value) { return this.sendText(JSON.stringify(value)); }
  sendText(text) { return this.#write(encodeFrame(0x1, Buffer.from(text, 'utf8'))); }
  ping(payload = '') { return this.#write(encodeFrame(0x9, Buffer.from(payload))); }
  close(code = 1000, reason = '') {
    if (this.closed) return;
    const safeReason = Buffer.from(String(reason).slice(0, 120), 'utf8'); const body = Buffer.alloc(2 + safeReason.length); body.writeUInt16BE(code, 0); safeReason.copy(body, 2);
    try { this.socket.write(encodeFrame(0x8, body)); } catch {}
    this.closed = true; this.socket.end(); this.#markClosed();
  }
  #write(frame) { if (this.closed || this.socket.destroyed) return false; return this.socket.write(frame); }
  #markClosed() { if (!this.closed) this.closed = true; for (const handler of [...this.closeHandlers]) { try { handler(); } catch {} } this.closeHandlers.clear(); this.messageHandlers.clear(); }
  #drain() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0], second = this.buffer[1], fin = (first & 0x80) !== 0, opcode = first & 0x0f, masked = (second & 0x80) !== 0;
      if (!masked) throw new ProtocolError('BAD_WEBSOCKET', 'Client frames must be masked');
      let length = second & 0x7f, offset = 2;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (this.buffer.length < 10) return; const wide = this.buffer.readBigUInt64BE(2); if (wide > BigInt(MAX_FRAME_BYTES)) throw new ProtocolError('FRAME_TOO_LARGE', 'Frame too large'); length = Number(wide); offset = 10; }
      if (length > MAX_FRAME_BYTES) throw new ProtocolError('FRAME_TOO_LARGE', 'Frame too large');
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4); offset += 4; const payload = Buffer.from(this.buffer.subarray(offset, offset + length)); this.buffer = this.buffer.subarray(offset + length);
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      if (opcode === 0x8) { this.close(1000, 'peer closed'); return; }
      if (opcode === 0x9) { this.#write(encodeFrame(0xA, payload)); continue; }
      if (opcode === 0xA) { this.lastPongAt = Date.now(); continue; }
      if (opcode !== 0x0 && opcode !== 0x1) throw new ProtocolError('BAD_WEBSOCKET', 'Only text frames are supported');
      if (opcode === 0x1) { if (this.fragmentOpcode !== null) throw new ProtocolError('BAD_WEBSOCKET', 'Unexpected new data frame during fragmentation'); if (fin) this.#emitText(payload); else { this.fragmentOpcode = opcode; this.fragments = [payload]; } }
      else { if (this.fragmentOpcode === null) throw new ProtocolError('BAD_WEBSOCKET', 'Unexpected continuation frame'); this.fragments.push(payload); const total = this.fragments.reduce((sum, part) => sum + part.length, 0); if (total > MAX_FRAME_BYTES) throw new ProtocolError('FRAME_TOO_LARGE', 'Fragmented message too large'); if (fin) { const joined = Buffer.concat(this.fragments); this.fragments = []; this.fragmentOpcode = null; this.#emitText(joined); } }
    }
  }
  #emitText(payload) { const text = payload.toString('utf8'); for (const handler of [...this.messageHandlers]) Promise.resolve().then(() => handler(text)).catch(() => undefined); }
}
