import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, verify } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readConfig, validateCall, validateBridge } from '../src/config.ts';
import { buildCall, createJWT, requestCall } from '../src/vonage.ts';
import { sessionStart } from '../src/live-session.ts';

const env = {
  PHONE_NUMBER: '+15555550123',
  VONAGE_APPLICATION_ID: 'example-application',
  VONAGE_PRIVATE_KEY_PATH: 'example.key',
  BRIDGE_TOKEN: 't'.repeat(64),
  PUBLIC_URL: 'https://example.invalid',
};
test('mode-specific defaults and required settings keep echo independent of OpenAI', () => {
  const echo = readConfig(env, ['--mode=echo']);
  validateCall(echo);
  validateBridge(echo);
  assert.equal(echo.maxSeconds, 30);
  assert.equal(echo.phone, '15555550123');
  const live = readConfig(env, ['--mode=live']);
  assert.equal(live.maxSeconds, 180);
  assert.throws(() => validateBridge(live), /OPENAI_API_KEY/);
  for (const value of ['0', '301', '1.5', 'invalid'])
    assert.throws(() => readConfig({ MAX_SECONDS: value }, []));
  assert.throws(() => readConfig({}, ['--mode=other']));
  assert.throws(() => readConfig({ PORT: '0' }, []));
});
test('tts does not require a tunnel; echo requires a bare HTTPS origin', () => {
  const tts = readConfig({ ...env, PUBLIC_URL: '' }, ['--mode=tts']);
  validateCall(tts);
  assert.equal(buildCall(tts).ncco.length, 1);
  for (const url of [
    'http://example.invalid',
    'https://example.invalid/path',
    'https://a:b@example.invalid',
    'https://example.invalid/?token=x',
  ]) {
    assert.throws(() => validateCall(readConfig({ ...env, PUBLIC_URL: url }, ['--mode=echo'])));
  }
});
test('call instructions carry matching PCM and auth settings and a bounded call duration', () => {
  const config = readConfig(env, ['--mode=echo']);
  validateCall(config);
  const request = buildCall(config);
  assert.equal(request.length_timer, 45);
  assert.equal(request.to[0].number, config.phone);
  const connect = request.ncco[1];
  assert.equal(connect.action, 'connect');
  if (connect.action !== 'connect') throw new Error('missing connect');
  assert.equal(connect.endpoint[0]['content-type'], 'audio/l16;rate=24000');
  assert.equal(connect.endpoint[0].authorization.value, `Bearer ${config.token}`);
  assert.equal(sessionStart('example-model').session.model, 'gpt-live-1');
});
test('JWT signatures use the configured application key; ambiguous requests are not retried', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'phone-handson-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPath = path.join(dir, 'test.key');
  await writeFile(keyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const config = readConfig({ ...env, VONAGE_PRIVATE_KEY_PATH: keyPath }, ['--mode=tts']);
  validateCall(config);
  const jwt = await createJWT(config);
  const [header, payload, signature] = jwt.split('.');
  assert.ok(
    verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      pair.publicKey,
      Buffer.from(signature, 'base64url'),
    ),
  );
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.equal(claims.application_id, config.applicationId);
  assert.equal(claims.exp - claims.iat, 300);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    throw new Error('timeout');
  });
  await assert.rejects(requestCall(config), /発信結果が不明/);
  assert.equal(requests, 1);
});
test('dry run checks configuration without needing the key file or making a call', () => {
  const command = spawnSync(process.execPath, ['--import', 'tsx', 'src/call.ts', '--mode=tts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
  assert.equal(command.status, 0, command.stderr);
  assert.match(command.stdout, /発信していません/);
});
test('setup creates local credentials and preserves them on subsequent runs', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'phone-handson-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const args = [
    '--import',
    fileURLToPath(import.meta.resolve('tsx')),
    fileURLToPath(new URL('../scripts/setup.ts', import.meta.url)),
  ];
  const first = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const original = await readFile(path.join(dir, '.local/vonage-private.key'), 'utf8');
  const settings = await readFile(path.join(dir, '.env'), 'utf8');
  assert.match(settings, /^PHONE_NUMBER=$/m);
  assert.match(settings, /^BRIDGE_TOKEN=[a-f0-9]{64}$/m);
  const second = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8' });
  assert.equal(second.status, 1);
  assert.equal(await readFile(path.join(dir, '.local/vonage-private.key'), 'utf8'), original);
});
