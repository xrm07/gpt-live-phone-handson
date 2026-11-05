import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function signalChild(body: string) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      `
    import { installShutdownHandlers } from './src/server.ts';
    ${body}
    console.log('ready');
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  const exited = once(child, 'exit');
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    await once(child.stdout, 'data');
    child.kill('SIGINT');
    const [code, signal] = await exited;
    return { code, signal, output };
  } finally {
    clearTimeout(force);
  }
}

test('SIGINT waits for asynchronous bridge cleanup before normal process exit', async () => {
  const result = await signalChild(`
    const keepAlive = setInterval(() => {}, 1000);
    installShutdownHandlers(() => new Promise(resolve => setTimeout(() => {
      console.log('cleanup complete'); clearInterval(keepAlive); resolve();
    }, 30)), 1000);
  `);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(result.output, /cleanup complete/);
});
test('SIGINT retains the force deadline while cleanup never resolves', async () => {
  const result = await signalChild(`
    installShutdownHandlers(() => new Promise(() => {}), 50);
    setInterval(() => {}, 1000);
  `);
  assert.equal(result.code, 1);
  assert.equal(result.signal, null);
});
