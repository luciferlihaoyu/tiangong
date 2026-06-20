#!/usr/bin/env node
/**
 * ⚠️  已过时 (OUTDATED) — 保留供参考，不再推荐用于新验证。
 *
 * 该 stub 仅覆盖 P2 command bridge 基础心跳 + task.updateProgress done，
 * 未覆盖 A2A-lite v0.1 完整生命周期（dispatch / ack / submitResult / artifact / usage）。
 *
 * 请使用第二轮端到端 smoke 脚本替代：
 *   npm run smoke:connector
 *   或 node scripts/smoke/connector-a2a-e2e.mjs
 *
 * 原说明：
 *   Verify connector command mode with stdin prompt and result writeback
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';

const port = parseInt(process.env.PORT || '4899', 10);
let heartbeatCount = 0;
const updates = [];
const task = {
  id: 9001,
  taskId: 'P2-CMD-STUB',
  name: 'P2 command bridge stub smoke',
  description: 'Verify connector command mode with stdin prompt and result writeback',
  input: 'Run echo-runner and return output',
};

function send(res, data) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ result: { data } }));
}

const server = http.createServer(async (req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const path = new URL(req.url, `http://localhost:${port}`).pathname;
    let input = {};
    try { input = body ? JSON.parse(body) : {}; } catch {}

    if (path.endsWith('/agent.updateHeartbeat')) {
      heartbeatCount++;
      send(res, { success: true, claimedTask: heartbeatCount === 1 ? task : null });
      return;
    }
    if (path.endsWith('/agent.claimTask')) {
      send(res, { task: null });
      return;
    }
    if (path.endsWith('/task.updateProgress')) {
      updates.push(input);
      console.log('UPDATE', JSON.stringify(input));
      send(res, { success: true });
      if (input.status === 'done' || input.status === 'failed') {
        setTimeout(() => {
          console.log('FINAL_UPDATES', JSON.stringify(updates));
          for (const client of wss.clients) {
            try { client.close(1000, 'smoke complete'); } catch {}
          }
          wss.close(() => {
            server.close(() => process.exit(input.status === 'done' ? 0 : 2));
          });
        }, 100);
      }
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found', path }));
  });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.send(JSON.stringify({ type: 'welcome', ok: true }));
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      } catch {}
    });
  });
});

server.listen(port, () => console.log(`stub listening ${port}`));
setTimeout(() => {
  console.error('stub timeout');
  process.exit(3);
}, 20000);
