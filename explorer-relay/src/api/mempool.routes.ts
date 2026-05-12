import { Router } from 'express';
import type { AppState } from '../state/app-state.js';

export const mempoolRouter = (app: AppState): Router => {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(app.buildMempoolPayload());
  });

  router.get('/recent', (req, res) => {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 20));
    res.json(app.mempool.recentTxs(limit));
  });

  router.get('/fees', (_req, res) => {
    res.json(app.buildFeePayload());
  });

  router.get('/projected', (_req, res) => {
    res.json(app.buildMempoolPayload().projected_block);
  });

  return router;
};
