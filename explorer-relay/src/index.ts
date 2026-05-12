import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { closeDb, initDb } from './db/sqlite.js';
import { AppState } from './state/app-state.js';
import { apiRouter } from './api/routes.js';
import { attachWebSocketServer } from './websocket/ws-handler.js';

const log = createLogger('server');

const main = async (): Promise<void> => {
  initDb();

  const appState = new AppState();

  const server = express();
  server.disable('x-powered-by');
  server.use(cors({
    origin: config.CORS_ORIGINS.includes('*') ? '*' : config.CORS_ORIGINS,
    methods: ['GET', 'POST', 'OPTIONS'],
    credentials: false,
  }));
  server.use(express.json({ limit: '5mb' }));

  server.get('/health', (_req, res) => {
    const net = appState.network.get();
    res.json({
      ok: true,
      height: net.height || null,
      peers: net.peer_count,
      mempool_count: appState.mempool.size(),
      stale: appState.network.stale(),
      uptime_seconds: Math.floor(process.uptime()),
    });
  });

  server.use('/api', apiRouter(appState));

  server.use((_req, res) => res.status(404).json({ error: 'not found' }));

  server.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    log.error(`unhandled error: ${err.message}`, err.stack);
    res.status(500).json({ error: 'internal server error' });
  });

  const httpServer = createServer(server);
  attachWebSocketServer(httpServer, appState);

  await appState.start();

  httpServer.listen(config.SERVER_PORT, () => {
    log.info(`xmr-relay listening on :${config.SERVER_PORT}`);
    log.info(`cors origins: ${config.CORS_ORIGINS.join(', ')}`);
    log.info(`monerod: ${config.MONEROD_HOST}:${config.MONEROD_RPC_PORT} (zmq ${config.MONEROD_ZMQ_PORT})`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`${signal} — shutting down`);
    httpServer.close();
    await appState.stop();
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
};

main().catch(err => {
  log.error(`fatal: ${(err as Error).message}`, (err as Error).stack);
  process.exit(1);
});
