import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

// 配布対象を明示し、試験で生成したローカル設定や鍵を走査・表示しない。
const rootFiles = new Set([
  'README.md',
  'LICENSE',
  'AGENTS.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  '.gitignore',
  '.env.example',
]);
const rootDirs = new Set(['src', 'scripts', 'test', 'docs', '.github']);
const localDirs = new Set(['node_modules', '.git', '.local']);
const problems: string[] = [];
let checked = 0;
async function visit(dir = '.') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (dir === '.' && (localDirs.has(entry.name) || entry.name === '.env')) continue;
    if (entry.isSymbolicLink()) {
      problems.push(`${file}: シンボリックリンクを確認してください`);
      continue;
    }
    if (entry.isDirectory()) {
      if (dir === '.' && !rootDirs.has(entry.name)) problems.push(`${file}: 想定外のディレクトリ`);
      else await visit(file);
      continue;
    }
    if (dir === '.' && !rootFiles.has(entry.name)) {
      problems.push(`${file}: 想定外の配布ファイル`);
      continue;
    }
    if (
      /\.(key|pem|log|tgz)$/.test(entry.name) ||
      (entry.name.startsWith('.env') && entry.name !== '.env.example')
    ) {
      problems.push(`${file}: ローカル専用ファイル`);
      continue;
    }
    const text = await readFile(file, 'utf8');
    const patterns = [
      /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
      /-----BEGIN (?:RSA )?PRIVATE KEY-----/,
      /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
      /\/home\/[^/\s]+\//,
    ];
    if (patterns.some((pattern) => pattern.test(text)))
      problems.push(`${file}: 認証情報・実行環境固有の値を確認してください`);
    if (entry.name === '.env.example') {
      for (const name of [
        'PHONE_NUMBER',
        'OPENAI_API_KEY',
        'VONAGE_APPLICATION_ID',
        'BRIDGE_TOKEN',
        'PUBLIC_URL',
      ]) {
        if (!new RegExp(`^${name}=$`, 'm').test(text))
          problems.push(`${file}: ${name} は空欄にしてください`);
      }
    }
    checked++;
  }
}
await visit();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `配布対象${checked}ファイルを確認しました。.env / .local / node_modules は対象外です。`,
  );
