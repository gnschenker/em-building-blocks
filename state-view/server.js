import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { ProjectionManager } from 'es-dcb-library/projections';
import { store, pool } from './store.js';
import { cancelPolicyInCoolingOff } from './CancelPolicyInCoolingOff/CancelPolicyInCoolingOff.js';
import { policyDetailsProjection, getPolicyDetails } from './PolicyDetails/PolicyDetails.js';
import { coolingOffCancellationsProjection, listCoolingOffCancellations } from './CoolingOffCancellations/CoolingOffCancellations.js';

// Each projection has its own table and its own checkpoint row; the manager just runs them.
const projections = new ProjectionManager({
  pool,
  store,
  projections: [policyDetailsProjection, coolingOffCancellationsProjection(store)],
});
await projections.initialize();
projections.start();

const json = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

http.createServer(async (req, res) => {
  const details = req.method === 'GET' && req.url.match(/^\/policies\/([^/?]+)\/details$/);
  if (details) {
    const policy = await getPolicyDetails(pool, decodeURIComponent(details[1]));
    return policy ? json(res, 200, policy) : json(res, 404, { error: 'PolicyNotFound' });
  }
  if (req.method === 'GET' && req.url === '/ops/cooling-off-cancellations') {
    return json(res, 200, await listCoolingOffCancellations(pool));
  }
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
      return json(res, 201, event.data);
    } catch (err) {
      return json(res, 409, { error: err.message });
    }
  }
  const html = await readFile(new URL('./CancelPolicyInCoolingOff/CancelPolicyScreen.html', import.meta.url));
  res.writeHead(200, { 'content-type': 'text/html' }).end(html);
}).listen(3000, () => console.log('http://localhost:3000/?policyId=P1'));
