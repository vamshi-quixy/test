'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');

test('offline submission, restart replay, exclusive registration, receipts and literal text', {timeout: 30000}, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-test-')));
  const script = path.join(root, 'agentbus.js');
  fs.copyFileSync(path.join(__dirname, 'agentbus.js'), script);
  const key = createHash('sha256').update(root).digest('hex');
  const url = 'http://127.0.0.1:' + (20000 + parseInt(key.slice(0, 6), 16) % 30000);
  let server;
  async function start() {
    server = spawn(process.execPath, [script, 'serve']);
    await Promise.race([once(server.stdout, 'data'), once(server,'exit').then(() => {throw Error('startup failed');})]);
  }
  async function stop() {
    if (server && server.exitCode === null && !server.signalCode) {
      const exit = once(server, 'exit');
      server.kill();
      await exit;
    }
  }
  t.after(async () => { await stop(); fs.rmSync(root, { recursive: true }); });
  const identity = { name: 'codex', session: randomUUID() };
  const request = (op, data) => fetch(url + '/' + op, {method: 'POST', headers: {'x-agentbus': key},
    body: JSON.stringify(data), signal: AbortSignal.timeout(4000)});
  const input = 'quotes " $() & | \nsecond line 🪁';
  const send = (...args) => JSON.parse(execFileSync(process.execPath, [script, ...args], {input, encoding:'utf8'}));
  const first = send('send','claude','codex','task','-').submitted;
  await start();
  assert.equal((await (await request('wait', identity)).json()).body, input);
  assert.equal((await request('wait', {...identity, session: randomUUID()})).status, 409);
  await stop();
  await start();
  assert.equal((await (await request('wait', identity)).json()).id, first);
  assert.equal((await request('ack', {...identity, id:first})).status, 200);
  const waiting = request('wait', identity);
  const second = send('say','codex','second').submitted;
  const msg = await (await waiting).json();
  assert.equal(msg.id, second);
  assert.equal(msg.from, 'human');
  await request('ack', {...identity,id:second});
  await stop();
  await start();
  const status = await (await request('status', {})).json();
  assert.deepEqual(status.codex, {connected:false,pending:0});
});
