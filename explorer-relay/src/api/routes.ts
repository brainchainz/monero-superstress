import { Router } from 'express';
import type { AppState } from '../state/app-state.js';
import { mempoolRouter } from './mempool.routes.js';
import { blocksRouter } from './blocks.routes.js';
import { broadcastHandler, txRouter } from './tx.routes.js';
import { networkRouter } from './network.routes.js';
import { emissionRouter, miningRouter, staleRouter } from './mining.routes.js';
import { statsRouter } from './stats.routes.js';

export const apiRouter = (app: AppState): Router => {
  const router = Router();

  router.use('/mempool', mempoolRouter(app));
  router.use('/blocks', blocksRouter(app));
  router.post('/broadcast', broadcastHandler);
  router.use('/tx', txRouter(app));
  router.use('/network', networkRouter(app));
  router.use('/mining', miningRouter(app));
  router.use('/emission', emissionRouter(app));
  router.use('/stale', staleRouter(app));
  router.use('/stats', statsRouter(app));

  return router;
};
