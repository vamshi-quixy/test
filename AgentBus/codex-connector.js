'use strict';

const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

// AgentBus lives in <project>/AgentBus, so Codex works in the project root (the parent folder).
// Pass Codex's own -C/--cd flag to the launcher to override for the TUI.
const projectRoot = path.dirname(fs.realpathSync(__dirname));

async function openRpc(url, token) {
  const ws = new WebSocket(url, { headers: { Authorization: 'Bearer ' + token } });
  await once(ws, 'open', { signal: AbortSignal.timeout(3000) });
  let sequence = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const packet = JSON.parse(data);
    const request = pending.get(packet.id);
    if (request && !packet.method) {
      if (packet.error) request.reject(new Error(packet.error.message));
      else request.resolve(packet.result);
    }
  };
  ws.onclose = () => {
    for (const request of pending.values()) request.reject(new Error('Codex connection closed'));
  };
  async function call(method, params) {
    const id = ++sequence;
    let timer;
    try {
      return await new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        timer = setTimeout(() => reject(new Error(method + ' timed out')), 10000);
        ws.send(JSON.stringify({ method, id, params }));
      });
    } finally { clearTimeout(timer); pending.delete(id); }
  }
  try {
    await call('initialize', { clientInfo: { name: 'agentbus', version: '1' }, capabilities: {} });
    ws.send(JSON.stringify({ method: 'initialized' }));
    return { call, close: () => ws.close() };
  } catch (err) { ws.close(); throw err; }
}

async function deliver(rpc, threadId, message) {
  const params = { threadId, input: [{ type: 'text', text: 'AgentBus message (read AgentBus/AGENTBUS.md; reply with node AgentBus/agentbus.js send)\n' + JSON.stringify(message) }],
    clientUserMessageId: message.id };
  const { thread } = await rpc.call('thread/read', { threadId });
  if (thread.status.type === 'active') {
    const { data } = await rpc.call('thread/turns/list', { threadId, limit: 1, itemsView: 'notLoaded' });
    if (data[0]?.status !== 'inProgress') throw new Error('Waiting for the active turn ID');
    return rpc.call('turn/steer', { ...params, expectedTurnId: data[0].id });
  }
  if (thread.status.type !== 'idle') throw new Error('Codex thread is ' + thread.status.type);
  return rpc.call('turn/start', params);
}

async function startBackend() {
  const probe = net.createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const url = 'ws://127.0.0.1:' + probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentbus-'));
  const token = randomBytes(32).toString('hex');
  const file = path.join(dir, 'token');
  fs.writeFileSync(file, token, { mode: 0o600 });
  const backend = spawn('codex', ['app-server', '--listen', url, '--ws-auth', 'capability-token', '--ws-token-file', file],
    { cwd: projectRoot, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let diagnostic = '';
  backend.stderr.on('data', data => { diagnostic = (diagnostic + data).slice(-1000); });
  backend.on('error', err => { diagnostic = err.message; });
  const stop = () => { backend.kill(); fs.rmSync(file, { force: true }); fs.rmdirSync(dir); };
  try {
    let err;
    for (let i = 0; i < 60 && backend.exitCode === null; i++) {
      try { return { rpc: await openRpc(url, token), url, token, stop }; }
      catch (e) { err = e; await sleep(150); }
    }
    throw new Error('Codex app-server startup failed. ' + diagnostic + ' ' + (err?.message || ''));
  } catch (e) { stop(); throw e; }
}

async function launch(listen, args) {
  const { rpc, url, token, stop } = await startBackend();
  const tui = spawn('codex', ['--remote', url, '--remote-auth-token-env', 'AGENTBUS_WS_TOKEN', ...args],
    { cwd: projectRoot, stdio: 'inherit', env: { ...process.env, AGENTBUS_WS_TOKEN: token } });
  const done = once(tui, 'exit');
  const controller = new AbortController();
  async function bridge() {
    while (!controller.signal.aborted) {
      const { data } = await rpc.call('thread/loaded/list', { limit: 2 });
      if (data.length === 1) {
        const threadId = data[0];
        return listen('codex', msg => deliver(rpc, threadId, msg), controller.signal);
      }
      if (data.length > 1) throw new Error('Open a single project thread for this connector.');
      await sleep(300);
    }
  }
  try {
    await Promise.race([done.then(([code]) => { process.exitCode = code ?? 1; }), bridge()]);
  } finally { controller.abort(); tui.kill(); rpc.close(); stop(); }
}
module.exports = { launch, startBackend, deliver };
