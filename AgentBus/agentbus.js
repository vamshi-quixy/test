'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');

const root = fs.realpathSync(__dirname);
const key = crypto.createHash('sha256').update(root).digest('hex');
const port = 20000 + parseInt(key.slice(0, 6), 16) % 30000;
const base = 'http://127.0.0.1:' + port;
const names = ['claude', 'codex'];
const types = ['task', 'question', 'result', 'review', 'fyi'];
const check = (ok, message) => { if (!ok) throw new Error(message); };
const outbox = path.join(root, '.agentbus-outbox');
function validate({ from, to, type, body }) {
  check([...names, 'human'].includes(from) && names.includes(to) && from !== to, 'Invalid sender or recipient');
  check(types.includes(type) && typeof body === 'string' && body.trim(), 'Invalid type or empty message');
  check(Buffer.byteLength(body) <= 65536, 'Message exceeds 64 KiB');
}

function submit(message) {
  validate(message);
  fs.mkdirSync(outbox, { recursive: true, mode: 0o700 });
  const id = crypto.randomUUID();
  const file = path.join(outbox, Date.now() + '-' + id);
  fs.writeFileSync(file + '.tmp', JSON.stringify({ id, time: new Date().toISOString(), ...message }), { flush: true, mode: 0o600 });
  fs.renameSync(file + '.tmp', file + '.json');
  return { submitted: id };
}
function reply(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function serve() {
  const file = path.join(root, 'transcript.jsonl');
  const pending = new Map(names.map(name => [name, []]));
  const peers = new Map();
  const seen = new Set();
  function apply(event) {
    const queue = pending.get(event.to);
    if (event.ack) {
      check(queue[0]?.id === event.ack, 'Invalid transcript receipt');
      queue.shift();
    } else {
      seen.add(event.id);
      queue.push(event);
    }
  }
  function record(event) {
    fs.appendFileSync(file, JSON.stringify(event) + '\n', { flush: true, mode: 0o600 });
    apply(event);
  }
  function deliver(name) {
    const peer = peers.get(name);
    const message = pending.get(name)[0];
    if (peer?.wait && !peer.wait.writableEnded && message) reply(peer.wait, 200, message);
  }
  // File I/O can fail transiently on Windows (antivirus, indexer, sharing locks).
  // Never let that escape into the fs.watch/setInterval callbacks and crash the server:
  // leave the entry in place and end this pass so FIFO order is preserved; the next pass retries.
  function drain() {
    let entries;
    try {
      entries = fs.readdirSync(outbox).filter(name => name.endsWith('.json')).sort();
    } catch (error) {
      console.error('Outbox unreadable, will retry:', error.message);
      return;
    }
    for (const name of entries) {
      const file = path.join(outbox, name);
      let contents;
      try {
        contents = fs.readFileSync(file);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        console.error('Outbox entry busy, will retry:', name, error.message);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(contents);
        validate(msg);
        check(typeof msg.id === 'string' && name.endsWith('-' + msg.id + '.json'), 'Invalid message ID');
      } catch (error) {
        try {
          fs.renameSync(file, file + '.invalid');
          console.error('Invalid outbox entry:', name, error.message);
        } catch (renameError) {
          console.error('Invalid outbox entry busy, will retry:', name, renameError.message);
          return;
        }
        continue;
      }
      try {
        if (!seen.has(msg.id)) record(msg);
        fs.unlinkSync(file);
      } catch (error) {
        // Recorded-but-not-unlinked entries are deduplicated via `seen` on the next pass.
        console.error('Outbox entry not finalised, will retry:', name, error.message);
        return;
      } finally {
        if (seen.has(msg.id)) deliver(msg.to);
      }
    }
  }
  const server = http.createServer(async (req, res) => {
    try {
      check(req.method === 'POST' && req.headers['x-agentbus'] === key && !req.headers.origin, 'Wrong project or client');
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        check((size += chunk.length) <= 131072, 'Message too large');
        chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString());
      const now = Date.now();
      if (req.url === '/status') {
        return reply(res, 200, Object.fromEntries(names.map(name => [name, {
          connected: (peers.get(name)?.expires || 0) > now, pending: pending.get(name).length
        }])));
      }
      const { name, session } = data;
      check(names.includes(name) && typeof session === 'string' && session.length === 36, 'Invalid listener');
      check(['/wait', '/ack', '/leave'].includes(req.url), 'Unknown operation');
      let peer = peers.get(name);
      if (peer && peer.session !== session && peer.expires > now) return reply(res, 409, { error: name + ' already has a listener' });
      if (req.url === '/leave') {
        if (peer?.session === session) peers.delete(name);
        return reply(res, 200, {});
      }
      if (peer?.session !== session) peers.set(name, peer = { session });
      peer.expires = now + 35000;
      if (req.url === '/ack') {
        check(data.id && pending.get(name)[0]?.id === data.id, 'Receipt does not match queue head');
        record({ ack: data.id, to: name });
        return reply(res, 200, {});
      }
      if (peer.wait && !peer.wait.writableEnded) reply(peer.wait, 200, null);
      peer.wait = res;
      const timer = setTimeout(() => reply(res, 200, null), 20000);
      res.once('close', () => {
        clearTimeout(timer);
        if (peer.wait === res) {
          peer.wait = null;
          if (!res.writableEnded) peer.expires = 0;
        }
      });
      deliver(name);
    } catch (error) { if (!res.headersSent) reply(res, 400, { error: error.message }); }
  });
  server.listen(port, '127.0.0.1', () => {
    if (fs.existsSync(file)) {
      const bytes = fs.readFileSync(file);
      const end = bytes.lastIndexOf(10) + 1;
      for (const line of bytes.subarray(0, end).toString().split('\n')) if (line) apply(JSON.parse(line));
      if (end < bytes.length) fs.truncateSync(file, end);
    }
    console.log('AgentBus listening at ' + base);
    fs.mkdirSync(outbox, { recursive: true, mode: 0o700 });
    fs.watch(outbox, drain).on('error', error => console.error('Outbox watcher error (polling continues):', error.message));
    drain();
    setInterval(drain, 5000);
  });
}

async function post(route, data, signal) {
  const res = await fetch(base + '/' + route, { method: 'POST', headers: { 'x-agentbus': key },
    body: JSON.stringify(data), signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]) });
  const value = await res.json();
  if (!res.ok) throw Object.assign(new Error(value.error), { status: res.status });
  return value;
}

async function listen(name, receive, signal) {
  check(names.includes(name), 'Expected claude or codex');
  const identity = { name, session: crypto.randomUUID() };
  try {
    while (!signal?.aborted) {
      try {
        const message = await post('wait', identity, signal);
        if (!message || signal?.aborted) continue;
        await receive(message);
        await post('ack', { ...identity, id: message.id });
      } catch (error) {
        if (signal?.aborted) break;
        if (error.status === 409) throw error;
        console.error('AgentBus listener:', error.message);
        await sleep(1500);
      }
    }
  } finally { await post('leave', identity).catch(() => {}); }
}

async function main([cmd, ...args]) {
  if (cmd === 'serve') return serve();
  if (cmd === 'status') return console.log(await post('status', {}));
  if (cmd === 'listen') return listen(args[0], msg => new Promise((resolve, reject) =>
    process.stdout.write(JSON.stringify(msg) + '\n', err => err ? reject(err) : resolve())));
  if (cmd === 'codex') return require('./codex-connector').launch(listen, args);
  if (cmd === 'send' || cmd === 'say') {
    const from = cmd === 'say' ? 'human' : args.shift();
    const to = args.shift();
    const type = cmd === 'say' ? 'task' : args.shift();
    const body = args.length === 1 && args[0] === '-' ? fs.readFileSync(0, 'utf8') : args.join(' ');
    return console.log(JSON.stringify(submit({ from, to, type, body })));
  }
  throw new Error('See AGENTBUS.md for serve, codex, listen, send, say and status.');
}
if (require.main === module) main(process.argv.slice(2)).catch(err => { console.error(err.message); process.exitCode = 1; });
