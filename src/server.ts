import { readConfig, validateBridge } from './config.ts';
import { createBridge } from './bridge.ts';
import { pathToFileURL } from 'node:url';

// close()はLiveの最終通知または期限後のtransport終了まで待つ。
export function installShutdownHandlers(close: () => Promise<void>, forceAfterMs = 12_000) {
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(1), forceAfterMs);
    try {
      await close();
      clearTimeout(force);
    } catch {
      console.error('終了処理に失敗しました。OpenAIのUsageも確認してください。');
      process.exitCode = 1;
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = readConfig();
    validateBridge(config);
    const bridge = createBridge(config);
    installShutdownHandlers(bridge.close);
    bridge.server.on('error', (error) => {
      console.error(
        (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? 'ポートが使用中です。前のサーバーを終了してください。'
          : '中継サーバーを起動できませんでした。',
      );
      process.exitCode = 1;
    });
    bridge.server.listen(config.port, '127.0.0.1', () => {
      console.log(`Bridge ready on localhost:${config.port} (${config.mode})`);
      console.log(`中継は1通話、最大${config.maxSeconds}秒。終了はCtrl+Cです。`);
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : '起動に失敗しました。');
    process.exitCode = 1;
  }
}
