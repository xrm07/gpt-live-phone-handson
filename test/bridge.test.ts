import { test, type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { BridgeOptions } from '../src/bridge.ts';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createBridge } from '../src/bridge.ts';
import { FakeLive } from './helpers/fake-live.ts';
import { connect as connectTCP } from 'node:net';

const token = 'a'.repeat(64);
async function start(t: TestContext, options: Partial<BridgeOptions> = {}) {
  const app = createBridge({ token, log: () => {}, shutdownGraceMs: 100, ...options });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const url = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}/audio`;
  t.after(() => app.close());
  return { app, url };
}
async function connect(url: string) {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  await once(ws, 'open');
  return ws;
}
test('unauthorized callers cannot consume the single call slot; PCM echo preserves bytes', async (t) => {
  const { url } = await start(t);
  const bad = new WebSocket(url);
  await once(bad, 'error');
  const ws = await connect(url);
  ws.send(JSON.stringify({ event: 'websocket:connected', 'content-type': 'audio/l16;rate=24000' }));
  const frame = Buffer.from([0, 0, 255, 127, 0, 128]);
  const answer = once(ws, 'message');
  ws.send(frame);
  const [received, binary] = await answer;
  assert.equal(binary, true);
  assert.deepEqual(received, frame);
  ws.close();
  await once(ws, 'close');
  const duplicate = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  await once(duplicate, 'error');
});
test('unsupported audio closes without starting an OpenAI session', async (t) => {
  let calls = 0;
  const { url } = await start(t, {
    mode: 'live',
    makeLive: () => {
      calls++;
      throw new Error();
    },
  });
  const ws = await connect(url);
  const closed = once(ws, 'close');
  ws.send(JSON.stringify({ event: 'websocket:connected', 'content-type': 'audio/l16;rate=16000' }));
  await closed;
  assert.equal(calls, 0);
});
test('Live audio crosses both directions and disconnect requests session finalization', async (t) => {
  const live = new FakeLive();
  const { url } = await start(t, {
    mode: 'live',
    makeLive: () => live.connect(),
  });
  const ws = await connect(url);
  const started = once(live, 'sent');
  ws.send(JSON.stringify({ event: 'websocket:connected', 'content-type': 'audio/l16;rate=24000' }));
  assert.equal((await started)[0].type, 'session.start');
  live.emit('event', { type: 'session.started', session: { id: 'test' } });
  const bytes = Buffer.from([1, 0, 2, 0]);
  const received = once(live, 'sent');
  ws.send(bytes);
  assert.equal((await received)[0].audio, bytes.toString('base64'));
  const audio = once(ws, 'message');
  live.emit('event', { type: 'session.output_audio.delta', delta: bytes.toString('base64') });
  assert.deepEqual((await audio)[0], bytes);
  const closeSent = once(live, 'sent');
  ws.close();
  await once(ws, 'close');
  assert.equal((await closeSent)[0].type, 'session.close');
  live.emit('event', { type: 'session.closed', usage: {} });
});

for (const payload of ['null', '[]', '"text"', '42', 'true', '{', '{}', '{"event":null}']) {
  test(`invalid metadata ${payload} closes only the connection`, async (t) => {
    const { app, url } = await start(t);
    const ws = await connect(url);
    const closed = once(ws, 'close');
    ws.send(payload);
    await closed;
    const response = await fetch(
      `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/health`,
    );
    assert.equal(response.status, 200); // 同じプロセスのサーバーは動き続ける。
    assert.equal(((await response.json()) as { active: boolean }).active, false);
  });
}

test('bridge.close waits for final usage and transport closure, including after phone disconnect', async (t) => {
  const live = new FakeLive();
  const { app, url } = await start(t, {
    mode: 'live',
    makeLive: () => live.connect(),
    shutdownGraceMs: 1000,
  });
  const ws = await connect(url);
  const started = once(live, 'sent');
  ws.send(JSON.stringify({ event: 'websocket:connected', 'content-type': 'audio/l16;rate=24000' }));
  await started;
  live.emit('event', { type: 'session.started', session: { id: 'test' } });
  const closeSent = once(live, 'sent');
  ws.close();
  await once(ws, 'close');
  assert.equal((await closeSent)[0].type, 'session.close');
  let done = false;
  const closing = app.close().then(() => {
    done = true;
  });
  assert.equal(app.close(), app.close());
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(done, false);
  assert.equal(live.socket.readyState, WebSocket.OPEN);
  live.emit('event', { type: 'session.closed', usage: { seconds: 1 } });
  await closing;
  assert.equal(live.socket.readyState, WebSocket.CLOSED);
  assert.equal(live.terminateCalls, 0);
});

test('an unresponsive phone close handshake is terminated at the shutdown deadline', async (t) => {
  const { app } = await start(t);
  const peer = connectTCP({ host: '127.0.0.1', port: (app.server.address() as AddressInfo).port });
  t.after(() => peer.destroy());
  await once(peer, 'connect');
  const handshake = once(peer, 'data');
  peer.write(
    [
      'GET /audio HTTP/1.1',
      'Host: localhost',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      `Authorization: Bearer ${token}`,
      '',
      '',
    ].join('\r\n'),
  );
  assert.match((await handshake)[0].toString(), /101 Switching Protocols/);
  // 生のTCPピアはWebSocket closeへ返答しない。
  const ended = once(peer, 'end');
  await app.close();
  await ended;
});

test('missing final event and unresponsive close handshake force the Live transport to end', async (t) => {
  const live = new FakeLive();
  live.ignoreClose = true;
  const logs: string[] = [];
  const { app, url } = await start(t, {
    mode: 'live',
    makeLive: () => live.connect(),
    log: (text) => logs.push(text),
  });
  const ws = await connect(url);
  const started = once(live, 'sent');
  ws.send(JSON.stringify({ event: 'websocket:connected', 'content-type': 'audio/l16;rate=24000' }));
  await started;
  live.emit('event', { type: 'session.started', session: { id: 'test' } });
  const phoneClosed = once(ws, 'close');
  await app.close();
  await phoneClosed;
  assert.equal(live.sent.at(-1)?.type, 'session.close');
  assert.equal(live.terminateCalls, 1);
  assert.equal(live.socket.readyState, WebSocket.CLOSED);
  assert.ok(logs.some((text) => text.includes('Final Live usage not received')));
});
test('test duration limit closes the phone connection', async (t) => {
  const { url } = await start(t, { maxSeconds: 1 });
  const ws = await connect(url);
  ws.send(JSON.stringify({ event: 'websocket:connected', 'content-type': 'audio/l16;rate=24000' }));
  await once(ws, 'close');
});
