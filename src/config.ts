// 設定は読み取り時に検証する。エラーメッセージには設定値や秘密を含めない。
export type Mode = 'tts' | 'echo' | 'live';
export interface Config {
  mode: Mode;
  maxSeconds: number;
  port: number;
  token?: string;
  publicUrl?: string;
  apiKey?: string;
  backendModel: string;
  applicationId?: string;
  privateKeyPath?: string;
  phone?: string;
  from: string;
}
export type CallConfig = Config & { applicationId: string; privateKeyPath: string; phone: string };
export type BridgeConfig = Config & { mode: 'echo' | 'live'; token: string };

export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
): Config {
  const modeArg = argv.find((arg) => arg.startsWith('--mode='));
  const mode = modeArg?.slice(7) ?? 'echo';
  if (!['tts', 'echo', 'live'].includes(mode))
    throw new Error('--mode は tts / echo / live を指定してください。');
  const maxSeconds = Number(env.MAX_SECONDS || (mode === 'live' ? 180 : 30));
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 300)
    throw new Error('MAX_SECONDS は1〜300の整数にしてください。');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT は1〜65535の整数にしてください。');
  return {
    mode: mode as Mode,
    maxSeconds,
    port,
    token: env.BRIDGE_TOKEN,
    publicUrl: env.PUBLIC_URL,
    apiKey: env.OPENAI_API_KEY,
    backendModel: env.BACKEND_MODEL || 'gpt-5.6-luna',
    applicationId: env.VONAGE_APPLICATION_ID,
    privateKeyPath: env.VONAGE_PRIVATE_KEY_PATH,
    phone: env.PHONE_NUMBER?.replace(/^\+/, ''),
    from: env.VONAGE_FROM || '123456789',
  };
}

export function requireSetting(value: unknown, name: string): asserts value is string {
  if (!value) throw new Error(`${name} を .env に設定してください。`);
}

export function validateBridge(config: Config): asserts config is BridgeConfig {
  if (!['echo', 'live'].includes(config.mode))
    throw new Error('サーバーのモードは echo / live です。');
  if (!config.token || config.token.length < 32)
    throw new Error(
      'BRIDGE_TOKEN には32文字以上のランダム値が必要です。npm run setup で生成できます。',
    );
  if (config.mode === 'live') requireSetting(config.apiKey, 'OPENAI_API_KEY');
}

export function validateCall(config: Config): asserts config is CallConfig {
  requireSetting(config.applicationId, 'VONAGE_APPLICATION_ID');
  requireSetting(config.privateKeyPath, 'VONAGE_PRIVATE_KEY_PATH');
  requireSetting(config.phone, 'PHONE_NUMBER');
  if (!/^[1-9]\d{7,14}$/.test(config.phone))
    throw new Error('PHONE_NUMBER は国番号から始まるE.164形式で指定してください。');
  if (!/^[1-9]\d{7,14}$/.test(config.from))
    throw new Error('VONAGE_FROM は数字だけで指定してください。');
  if (config.mode !== 'tts') {
    requireSetting(config.publicUrl, 'PUBLIC_URL');
    let url;
    try {
      url = new URL(config.publicUrl);
    } catch {
      throw new Error('PUBLIC_URL は https:// から始まるURLにしてください。');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new Error('PUBLIC_URL はパスや認証情報を含まないHTTPSのオリジンにしてください。');
    validateBridge(config);
  }
}
