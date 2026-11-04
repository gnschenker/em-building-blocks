import http from 'node:http';
import { store } from './store.js';
import { ingest as ingestLabResult } from './LabResult/LabResult.js';
import { ingest as ingestDirectDebitReturn } from './DirectDebitReturn/DirectDebitReturn.js';
import { ingest as ingestDeathNotice } from './DeathRegistryNotice/DeathRegistryNotice.js';

const feeds = {
  '/feeds/lab-results': ingestLabResult,
  '/feeds/direct-debit-returns': ingestDirectDebitReturn,
  '/feeds/death-notices': ingestDeathNotice,
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
