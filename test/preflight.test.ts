import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dial } from '../src/call.ts';
import { readConfig, validateCall } from '../src/config.ts';

const config = readConfig(
  {
    PHONE_NUMBER: '15555550123',
    VONAGE_APPLICATION_ID: 'example-application',
    VONAGE_PRIVATE_KEY_PATH: 'unused.key',
    BRIDGE_TOKEN: 't'.repeat(64),
    PUBLIC_URL: 'https://example.invalid',
  },
  ['--mode=echo'],
);
validateCall(config);

const cases: Array<[string, () => Promise<Response>]> = [
  [
    'network error',
    async () => {
      throw new TypeError('unavailable');
    },
  ],
  [
    'HTTP failure',
    async () => Response.json({ ok: true, mode: 'echo', used: false }, { status: 503 }),
  ],
  ['invalid JSON', async () => new Response('{')],
  ['null JSON', async () => Response.json(null)],
  ['mode mismatch', async () => Response.json({ ok: true, mode: 'live', used: false })],
  ['used bridge', async () => Response.json({ ok: true, mode: 'echo', used: true })],
  ['not healthy', async () => Response.json({ ok: false, mode: 'echo', used: false })],
  ['missing state', async () => Response.json({ ok: true, mode: 'echo' })],
];
for (const [label, fetchHealth] of cases) {
  test(`preflight ${label} prevents all call requests`, async () => {
    let calls = 0;
    await assert.rejects(
      dial(config, {
        fetchHealth,
        requestCall: async () => {
          calls++;
          return {};
        },
      }),
    );
    assert.equal(calls, 0);
  });
}
test('a healthy unused bridge permits exactly one call request', async () => {
  let calls = 0;
  const result = await dial(config, {
    fetchHealth: async () => Response.json({ ok: true, mode: 'echo', used: false }),
    requestCall: async () => {
      calls++;
      return { uuid: 'example-call' };
    },
  });
  assert.equal(result.uuid, 'example-call');
  assert.equal(calls, 1);
});

test('preflight errors do not expose response bodies or network details', async () => {
  const message = '中継の状態を取得できませんでした。サーバーと一時URLを確認してください。';
  for (const fetchHealth of [
    async () => new Response('PRIVATE_RESPONSE_FRAGMENT'),
    async () => new Response('PRIVATE_RESPONSE_FRAGMENT', { status: 503 }),
    async () => {
      throw new Error('PRIVATE_NETWORK_DETAIL');
    },
  ]) {
    let calls = 0;
    await assert.rejects(
      dial(config, {
        fetchHealth,
        requestCall: async () => {
          calls++;
          return {};
        },
      }),
      { message },
    );
    assert.equal(calls, 0);
  }
});
