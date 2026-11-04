import http from 'node:http';
import { ProjectionManager } from 'es-dcb-library/projections';
import { store, pool } from './store.js';
import { startProcessor } from './processor.js';
import * as lab from './LabResult/LabResult.js';
import * as debit from './DirectDebitReturn/DirectDebitReturn.js';
import * as death from './DeathRegistryNotice/DeathRegistryNotice.js';

const projections = [
  lab.translationProjection, lab.workerProjection,
  debit.translationProjection, debit.workerProjection,
  death.translationProjection, death.workerProjection,
];
const manager = new ProjectionManager({ pool, store, projections });
await manager.initialize();
manager.start();

startProcessor(() => lab.processTranslations({ pool, store }));
startProcessor(() => lab.processWork({ pool, store }));
startProcessor(() => debit.processTranslations({ pool, store }));
startProcessor(() => debit.processWork({ pool, store }));
startProcessor(() => death.processTranslations({ pool, store }));
startProcessor(() => death.processWork({ pool, store }));

const feeds = {
  '/feeds/lab-results': lab.ingest,
  '/feeds/direct-debit-returns': debit.ingest,
  '/feeds/death-notices': death.ingest,
};

http.createServer(async (req, res) => {
  const ingest = req.method === 'POST' && feeds[req.url];
  if (ingest) {
    let body = '';
    for await (const chunk of req) body += chunk;
    try {
      const event = await ingest(store, JSON.parse(body));
      if (!event) {
        res.writeHead(204).end();
        return;
      }
      res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify(event.data));
    } catch (err) {
      res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  res.writeHead(404).end();
}).listen(3000, () => console.log('http://localhost:3000/feeds/lab-results'));
