#!/usr/bin/env node
import http from 'node:http';

const port = Number(process.env.PORT || process.argv[2] || 18798);
let requests = 0;

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, requests }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    res.statusCode = 404;
    res.end('not found');
    return;
  }

  let body = '';
  req.setEncoding('utf8');
  for await (const chunk of req) body += chunk;
  requests++;

  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = {}; }
  const auth = req.headers.authorization ? 'set' : 'missing';
  const agent = req.headers['x-openclaw-agent-id'] || '(none)';
  const sessionKey = req.headers['x-openclaw-session-key'] || '(none)';
  const userMessage = parsed?.messages?.find?.((m) => m?.role === 'user')?.content || '';

  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({
    id: 'chatcmpl-p7-smoke',
    object: 'chat.completion',
    choices: [{
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: [
          'P7_GATEWAY_MOCK_OK',
          `agent=${agent}`,
          `session=${sessionKey}`,
          `auth=${auth}`,
          `promptChars=${userMessage.length}`,
        ].join('\n'),
      },
    }],
  }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`p7 mock gateway listening on http://127.0.0.1:${port}`);
});
