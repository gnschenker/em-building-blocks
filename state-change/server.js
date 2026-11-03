import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { store } from './store.js';
import { cancelPolicyInCoolingOff } from './CancelPolicyInCoolingOff/CancelPolicyInCoolingOff.js';

http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/commands/cancel-policy-in-cooling-off') {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { policyId, reason, coolingOffEndsAt } = JSON.parse(body);
    try {
      const event = await cancelPolicyInCoolingOff(store, {
        policyId,
        requestedAt: new Date().toISOString(), // server clock, not the user
        reason: reason || null,
        coolingOffEndsAt,
      });
      res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(event.data));
    } catch (err) {
      res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  const html = await readFile(new URL('./CancelPolicyInCoolingOff/CancelPolicyScreen.html', import.meta.url));
  res.writeHead(200, { 'content-type': 'text/html' }).end(html);
}).listen(3000, () => console.log('http://localhost:3000/?policyId=P1'));
