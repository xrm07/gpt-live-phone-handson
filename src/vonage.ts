import { readFile } from 'node:fs/promises';
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { AUDIO_CONTENT_TYPE } from './live-session.ts';
import type { CallConfig } from './config.ts';

interface TalkAction {
  action: 'talk';
  language: string;
  text: string;
}
interface ConnectAction {
  action: 'connect';
  timeout: number;
  limit: number;
  endpoint: Array<{
    type: 'websocket';
    uri: string;
    'content-type': string;
    authorization: { type: 'custom'; value: string };
  }>;
}
export interface CallResult {
  uuid?: string;
}

export const CALLS_URL = 'https://api.nexmo.com/v1/calls';

// NCCOは、応答後に何を読み上げ、どこへ音声をつなぐかをVonageへ渡す指示。
export function buildCall(config: CallConfig) {
  const ncco: Array<TalkAction | ConnectAction> = [
    {
      action: 'talk',
      language: 'ja-JP',
      text: {
        tts: 'これは電話回線の接続テストです。聞こえたら電話を切ってください。',
        echo: '音声の送受信テストです。話すと自分の声が返ります。',
        live: 'AIとの会話テストを始めます。',
      }[config.mode],
    },
  ];
  if (config.mode !== 'tts') {
    ncco.push({
      action: 'connect',
      timeout: 15,
      limit: config.maxSeconds,
      endpoint: [
        {
          type: 'websocket',
          uri: `${new URL(config.publicUrl!).origin.replace('https:', 'wss:')}/audio`,
          'content-type': AUDIO_CONTENT_TYPE,
          authorization: { type: 'custom', value: `Bearer ${config.token}` },
        },
      ],
    });
  }
  return {
    from: { type: 'phone', number: config.from },
    to: [{ type: 'phone', number: config.phone }],
    // 案内音声の分を含む電話回線全体の上限。中継自体の上限はmaxSeconds。
    length_timer: config.maxSeconds + 15,
    ncco,
  };
}

export async function createJWT(config: CallConfig) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    application_id: config.applicationId,
    iat: now,
    exp: now + 300,
    jti: randomUUID(),
  })}`;
  const key = createPrivateKey(await readFile(config.privateKeyPath));
  return `${payload}.${sign('RSA-SHA256', Buffer.from(payload), key).toString('base64url')}`;
}

export async function requestCall(config: CallConfig): Promise<CallResult> {
  const jwt = await createJWT(config);
  let response;
  try {
    // 再送すると別の電話になるため、この要求は自動リトライしない。
    response = await fetch(CALLS_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildCall(config)),
    });
  } catch {
    throw new Error('発信結果が不明です。再実行する前にVonageの通話ログを確認してください。');
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      '発信応答を解釈できませんでした。再実行する前にVonageの通話ログを確認してください。',
    );
  }
  if (!response.ok)
    throw new Error(
      `Vonageが発信を拒否しました（HTTP ${response.status}）。ダッシュボードの通話ログを確認してください。`,
    );
  return result as CallResult;
}
