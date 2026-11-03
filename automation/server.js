import http from 'node:http';
import { pool } from './store.js';
import { getCollectionDashboard } from './CollectionDashboard/CollectionDashboard.js';

// GET /dashboard/collections: what the business still owes itself, and what is late.
http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/dashboard/collections') {
    const body = await getCollectionDashboard(pool, new Date());
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  } else res.writeHead(404).end();
}).listen(3000);
