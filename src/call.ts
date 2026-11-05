import { readConfig, validateCall } from './config.ts';
import { requestCall } from './vonage.ts';
import type { CallConfig } from './config.ts';
import { pathToFileURL } from 'node:url';

// 外部アクセスはここにまとめ、テストでは取得と発信を両方スタブに差し替える。
export async function dial(
  config: CallConfig,
  dependencies = { fetchHealth: globalThis.fetch, requestCall },
) {
  if (config.mode !== 'tts') {
    let health: unknown;
    try {
      const response = await dependencies.fetchHealth(
        `${new URL(config.publicUrl!).origin}/health`,
        {
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw new Error();
      health = await response.json();
    } catch {
      throw new Error('中継の状態を取得できませんでした。サーバーと一時URLを確認してください。');
    }
    if (
      typeof health !== 'object' ||
      health === null ||
      !('ok' in health) ||
      health.ok !== true ||
      !('mode' in health) ||
      health.mode !== config.mode ||
      !('used' in health) ||
      health.used !== false
    )
      throw new Error(
        '中継が未起動、モードが不一致、または使用済みです。サーバーを確認してください。',
      );
  }
  return dependencies.requestCall(config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = readConfig();
    validateCall(config);
    if (!process.argv.includes('--dial')) {
      console.log(`設定確認: ${config.mode}、中継の上限${config.maxSeconds}秒。発信していません。`);
      console.log('発信するには同じコマンドへ -- --dial を追加してください。');
    } else {
      const result = await dial(config);
      console.log(`発信要求を受け付けました。Call ID: ${result.uuid ?? '通話ログで確認'}`);
      console.log('着信・音声・会話の成否は、携帯と中継ログの両方で確認してください。');
    }
  } catch (error) {
    // 通信ライブラリの例外にはURLなどが含まれる場合があるため既知の文言だけ表示する。
    console.error(
      error instanceof Error && !(error instanceof TypeError)
        ? error.message
        : '接続できませんでした。設定とネットワークを確認してください。',
    );
    process.exitCode = 1;
  }
}
