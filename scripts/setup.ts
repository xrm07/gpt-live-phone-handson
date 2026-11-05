import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';

// 各読者の端末で新しい鍵を作る。公開ディレクトリにはサンプルの秘密鍵も置かない。
try {
  const template = await readFile(new URL('../.env.example', import.meta.url), 'utf8');
  for (const file of ['.env', '.local/vonage-private.key', '.local/vonage-public.pem']) {
    try {
      await access(file);
      throw Object.assign(new Error(), { code: 'EEXIST' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await mkdir('.local', { recursive: true, mode: 0o700 });
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  // wxは既存ファイルがあれば失敗する。再実行しても使っている鍵を置き換えない。
  await writeFile('.local/vonage-private.key', pair.privateKey, { flag: 'wx', mode: 0o600 });
  await writeFile('.local/vonage-public.pem', pair.publicKey, { flag: 'wx', mode: 0o644 });
  const env = template.replace(
    /^BRIDGE_TOKEN=.*$/m,
    `BRIDGE_TOKEN=${randomBytes(32).toString('hex')}`,
  );
  await writeFile('.env', env, { flag: 'wx', mode: 0o600 });
  console.log('設定ファイルと鍵を生成しました。');
  console.log('Vonageには .local/vonage-public.pem の公開鍵を登録してください。');
  console.log('.env の電話番号・Application IDを設定すると、ttsとechoを試せます。');
} catch (error) {
  console.error(
    (error as NodeJS.ErrnoException).code === 'EEXIST'
      ? '既存の設定または鍵があります。上書きせず終了しました。'
      : '初期設定に失敗しました。ファイルの権限と作業ディレクトリを確認してください。',
  );
  process.exitCode = 1;
}
