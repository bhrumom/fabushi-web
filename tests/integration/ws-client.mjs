import net from 'node:net';
import { randomBytes } from 'node:crypto';
function maskedFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload); const mask = randomBytes(4); let header;
  if (body.length < 126) { header = Buffer.alloc(2); header[1] = 0x80 | body.length; }
  else if (body.length <= 0xffff) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(body.length, 2); }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(body.length), 2); }
  header[0] = 0x80 | opcode; const masked = Buffer.from(body); for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4]; return Buffer.concat([header, mask, masked]);
}
export class TestWebSocketClient {
  constructor(socket, initial = Buffer.alloc(0)) { this.socket = socket; this.buffer = initial; this.messages = []; this.waiters = new Set(); socket.on('data', (chunk) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.#drain(); }); socket.on('close', () => this.#wake()); if (initial.length) this.#drain(); }
  sendJson(value) { this.socket.write(maskedFrame(0x1, Buffer.from(JSON.stringify(value)))); }
  close() { if (!this.socket.destroyed) this.socket.end(maskedFrame(0x8, Buffer.from([0x03, 0xE8]))); }
  async waitFor(predicate, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.messages.findIndex(predicate); if (index >= 0) return this.messages.splice(index, 1)[0];
      const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error(`Timed out waiting for WebSocket message; queued=${JSON.stringify(this.messages)}`);
      await new Promise((resolve, reject) => { const waiter = () => { clearTimeout(timer); this.waiters.delete(waiter); resolve(); }; const timer = setTimeout(() => { this.waiters.delete(waiter); reject(new Error('WebSocket wait timeout')); }, remaining); this.waiters.add(waiter); });
    }
  }
  #wake() { for (const waiter of [...this.waiters]) waiter(); }
  #drain() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0], second = this.buffer[1], opcode = first & 0x0f, masked = (second & 0x80) !== 0; if (masked) throw new Error('Server frames must not be masked');
      let length = second & 0x7f, offset = 2;
      if (length === 126) { if (this.buffer.length < 4) return; length = this.buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (this.buffer.length < 10) return; length = Number(this.buffer.readBigUInt64BE(2)); offset = 10; }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length); this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x9) { this.socket.write(maskedFrame(0xA, payload)); continue; } if (opcode === 0x8) { this.socket.end(); return; }
      if (opcode === 0x1) { this.messages.push(JSON.parse(payload.toString('utf8'))); this.#wake(); }
    }
  }
}
export async function connectWebSocket({ port, cookie, origin, afterSeq = 0 }) {
  const socket = net.connect({ host: '127.0.0.1', port }); const key = randomBytes(16).toString('base64');
  socket.write([`GET /v1/coordinator?afterSeq=${afterSeq} HTTP/1.1`,`Host: 127.0.0.1:${port}`,'Connection: Upgrade','Upgrade: websocket','Sec-WebSocket-Version: 13',`Sec-WebSocket-Key: ${key}`,`Origin: ${origin}`,`Cookie: ${cookie}`,'\r\n'].join('\r\n'));
  let buffer = Buffer.alloc(0);
  const headers = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('WebSocket handshake timeout')), 5000); const onData = (chunk) => { buffer = Buffer.concat([buffer, chunk]); const index = buffer.indexOf('\r\n\r\n'); if (index < 0) return; clearTimeout(timer); socket.off('data', onData); resolve({ text: buffer.subarray(0, index).toString('utf8'), rest: buffer.subarray(index + 4) }); }; socket.on('data', onData); socket.once('error', reject); });
  if (!headers.text.startsWith('HTTP/1.1 101')) throw new Error(`WebSocket upgrade failed: ${headers.text}`);
  return new TestWebSocketClient(socket, headers.rest);
}
