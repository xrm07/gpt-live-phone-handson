import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { AUDIO_CONTENT_TYPE, connectLive, sessionStart } from './live-session.ts';
import type { LiveWS } from 'openai/resources/live/ws';

export interface BridgeOptions {
  token: string;
  mode?: 'echo' | 'live';
  maxSeconds?: number;
  apiKey?: string;
  backendModel?: string;
  makeLive?: () => LiveWS;
  log?: (message: string) => void;
  // テストでは待ち時間を短縮する。本番の終了待ちは10秒。
  shutdownGraceMs?: number;
}

export function createBridge({
  token,
  mode = 'echo',
  maxSeconds = 30,
  apiKey,
  backendModel = 'gpt-5.6-luna',
  makeLive = () => connectLive(apiKey),
  log = console.log,
  shutdownGraceMs = 10_000,
}: BridgeOptions) {
  if (!token || token.length < 32)
    throw new Error('A bridge token of at least 32 characters is required');
  if (!['echo', 'live'].includes(mode)) throw new Error('MODE must be echo or live');
  if (!Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 300)
    throw new Error('MAX_SECONDS must be 1–300');
  if (!Number.isInteger(shutdownGraceMs) || shutdownGraceMs < 1)
    throw new Error('shutdownGraceMs must be a positive integer');
  let active: { stop: (reason: string) => void } | undefined;
  let used = false;
  let shuttingDown = false;
  let callDone = Promise.resolve();
  let shutdown: Promise<void> | undefined;
  const authorized = (req: http.IncomingMessage) => {
    const value = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    return value.length === expected.length && timingSafeEqual(value, expected);
  };
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, mode, active: !!active, used }));
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  server.on('upgrade', (req, socket, head) => {
    if (shuttingDown || req.url !== '/audio' || !authorized(req) || active || used) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    // 1プロセスで受け入れる通話は1回。再試験はサーバーを再起動する。
    used = true;
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (phone) => {
    let live: LiveWS | undefined;
    let ready = false;
    let closing = false;
    let metadata = false;
    let closeTimer: NodeJS.Timeout | undefined;
    let closeSent = false;
    let finalized = false;
    let phoneClosed = false;
    let liveClosed = true;
    let resolveDone: () => void;
    callDone = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const finish = () => {
      if (!phoneClosed || !liveClosed) return;
      clearTimeout(closeTimer);
      active = undefined;
      resolveDone();
    };
    // 起動中の音声だけを最大3秒分保持し、session.started後に順番に送る。
    const pending: string[] = [];
    let pendingBytes = 0;
    // 電話の切断時はOpenAIへ終了を通知し、最終使用量を受け取って閉じる。
    const closeLive = () => {
      if (!live || closeSent) return;
      closeSent = true;
      if (!finalized && ready && live.socket.readyState === WebSocket.OPEN) {
        live.send({ type: 'session.close' });
      } else live.close();
    };
    const stop = (reason: string) => {
      if (closing) return;
      closing = true;
      log(`Call bridge closing: ${reason}`);
      clearTimeout(limit);
      clearTimeout(startup);
      // close()は握手を開始するだけ。期限後は両transportを強制終了する。
      closeTimer = setTimeout(() => {
        if (live && !finalized) log('Final Live usage not received; check OpenAI Usage.');
        if (!phoneClosed) phone.terminate();
        if (live && !liveClosed) {
          live.close();
          live.socket.terminate();
        }
      }, shutdownGraceMs);
      phone.close(1000, 'test complete');
      closeLive();
      finish();
    };
    const limit = setTimeout(() => stop('time limit'), maxSeconds * 1000);
    const startup = setTimeout(() => {
      if (!metadata || (mode === 'live' && !ready)) stop('startup timeout');
    }, 15_000);
    active = { stop };
    phone.on('error', () => stop('phone socket error'));
    phone.on('close', () => {
      phoneClosed = true;
      stop('phone disconnected');
      finish();
    });
    phone.on('message', (data, binary) => {
      const bytes = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data)
          ? data
          : Buffer.from(data);
      if (closing) return;
      if (!binary) {
        let event: unknown;
        try {
          event = JSON.parse(bytes.toString());
        } catch {
          stop('invalid metadata');
          return;
        }
        if (
          typeof event !== 'object' ||
          event === null ||
          Array.isArray(event) ||
          !('event' in event) ||
          typeof event.event !== 'string'
        ) {
          stop('invalid metadata');
          return;
        }
        if (event.event !== 'websocket:connected' || metadata) return;
        if (!('content-type' in event) || event['content-type'] !== AUDIO_CONTENT_TYPE) {
          stop('unsupported audio format');
          return;
        }
        metadata = true;
        log(`Phone audio connected (${mode}, PCM16 24kHz)`);
        if (mode === 'echo') {
          clearTimeout(startup);
          return;
        }
        try {
          live = makeLive();
        } catch {
          stop('OpenAI client configuration error');
          return;
        }
        const session = live;
        liveClosed = false;
        session.on('error', () => {
          log('Live error: connection/session error');
          stop('Live error');
        });
        session.socket.on('open', () => {
          if (closing) {
            session.close();
            return;
          }
          session.send(sessionStart(backendModel));
        });
        session.on('event', (event) => {
          if (event.type === 'session.started') {
            ready = true;
            clearTimeout(startup);
            log('GPT-Live session ready');
            if (closing) {
              closeLive();
              return;
            }
            for (const audio of pending)
              session.send({ type: 'session.input_audio.append', audio });
            pending.length = 0;
            pendingBytes = 0;
          } else if (
            event.type === 'session.output_audio.delta' &&
            !closing &&
            phone.readyState === WebSocket.OPEN
          ) {
            if (phone.bufferedAmount > 24000 * 2 * 2) {
              stop('audio backpressure');
              return;
            }
            phone.send(Buffer.from(event.delta, 'base64'));
          } else if (event.type === 'session.closed') {
            finalized = true;
            log(`Final Live usage: ${JSON.stringify(event.usage ?? {})}`);
            closeSent = true;
            session.close();
            stop('Live session ended');
          }
        });
        session.socket.on('close', () => {
          liveClosed = true;
          stop('Live disconnected');
          finish();
        });
        return;
      }
      if (!metadata) {
        stop('audio before metadata');
        return;
      }
      if (bytes.length % 2) {
        stop('invalid PCM frame');
        return;
      }
      // echoはPCMをそのまま返す。liveはBase64でOpenAIへ送る。
      if (mode === 'echo') {
        if (phone.bufferedAmount < 96_000) phone.send(bytes);
        else stop('echo backpressure');
      } else if (ready && live?.socket.readyState === WebSocket.OPEN) {
        if (live.socket.platformSocket.bufferedAmount > 96_000) {
          stop('Live backpressure');
          return;
        }
        live.send({ type: 'session.input_audio.append', audio: bytes.toString('base64') });
      } else {
        pendingBytes += bytes.length;
        if (pendingBytes > 24000 * 2 * 3) {
          stop('startup audio buffer exceeded');
          return;
        }
        pending.push(bytes.toString('base64'));
      }
    });
  });
  return {
    server,
    stop: () => active?.stop('server shutdown'),
    close: () => {
      // 同時に何度呼ばれても、新規接続を止めて同じ片付けを待つ。
      shutdown ??= (async () => {
        shuttingDown = true;
        const httpDone = new Promise<void>((resolve) => server.close(() => resolve()));
        const wsDone = new Promise<void>((resolve) => wss.close(() => resolve()));
        active?.stop('server shutdown');
        await Promise.all([callDone, httpDone, wsDone]);
      })();
      return shutdown;
    },
  };
}
