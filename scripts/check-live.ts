import { connectLive, sessionStart } from '../src/live-session.ts';
import { requireSetting, readConfig } from '../src/config.ts';

// 電話をかけず、音声を送らず、Liveセッションの作成と終了を確認する。
try {
  const config = readConfig();
  requireSetting(config.apiKey, 'OPENAI_API_KEY');
  const live = connectLive(config.apiKey);
  let started = false;
  let finalized = false;
  const timer = setTimeout(() => {
    console.error('接続または終了確認がタイムアウトしました。');
    live.close();
    process.exitCode = 1;
  }, 15_000);
  live.on('error', () => {
    console.error(
      'GPT-Liveに接続できません。キーの期限・Live/Responses権限・残高・モデル利用権限を確認してください。',
    );
    clearTimeout(timer);
    live.close();
    process.exitCode = 1;
  });
  live.socket.on('open', () => live.send(sessionStart(config.backendModel)));
  live.on('event', (event) => {
    if (event.type === 'session.started') {
      started = true;
      console.log('GPT-Live preflight: session started');
      live.send({ type: 'session.close' });
    } else if (event.type === 'session.closed') {
      finalized = true;
      console.log(`GPT-Live preflight: finalized / usage=${JSON.stringify(event.usage ?? {})}`);
      clearTimeout(timer);
      live.close();
    }
  });
  live.socket.on('close', () => {
    clearTimeout(timer);
    if (!started || !finalized) process.exitCode = 1;
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : '接続確認に失敗しました。');
  process.exitCode = 1;
}
