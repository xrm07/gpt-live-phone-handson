import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { LiveWS } from 'openai/resources/live/ws';
import type { ClientEvent } from 'openai/resources/live/live';

// SDKのイベント契約だけを模擬する。OpenAIへの接続は作らない。
export class FakeLive extends EventEmitter {
  sent: ClientEvent[] = [];
  closeCalls = 0;
  terminateCalls = 0;
  ignoreClose = false;
  socket = Object.assign(new EventEmitter(), {
    readyState: Number(WebSocket.OPEN),
    platformSocket: { bufferedAmount: 0 },
    terminate: () => {
      this.terminateCalls++;
      this.endTransport();
    },
  });
  send(event: ClientEvent) {
    this.sent.push(event);
    this.emit('sent', event);
  }
  close() {
    this.closeCalls++;
    if (!this.ignoreClose) this.endTransport();
  }
  private endTransport() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    this.socket.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.socket.emit('close'));
  }
  connect(): LiveWS {
    setImmediate(() => this.socket.emit('open'));
    return this as unknown as LiveWS;
  }
}
