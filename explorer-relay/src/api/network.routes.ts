import { Router } from 'express';
import type { AppState } from '../state/app-state.js';
import { getConnections } from '../rpc/monero-rpc.js';
import { getRecentBlockStats } from '../db/sqlite.js';
import { config } from '../config.js';

export const networkRouter = (app: AppState): Router => {
  const router = Router();

  router.get('/', (_req, res) => {
    res.json(app.network.get());
  });

  router.get('/hashrate', (req, res) => {
    const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 720));
    const rows = getRecentBlockStats(limit);
    const series = rows
      .sort((a, b) => a.height - b.height)
      .map(r => ({
        height: r.height,
        timestamp: r.timestamp,
        hashrate_ghs: r.difficulty > 0
          ? r.difficulty / config.BLOCK_TARGET_SECONDS / 1_000_000_000
          : 0,
      }));
    res.json(series);
  });

  router.get('/difficulty', (req, res) => {
    const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 720));
    const rows = getRecentBlockStats(limit);
    const series = rows
      .sort((a, b) => a.height - b.height)
      .map(r => ({ height: r.height, timestamp: r.timestamp, difficulty: r.difficulty }));
    res.json(series);
  });

  router.get('/peers', async (_req, res) => {
    const result = await getConnections();
    if (!result?.connections) return res.status(502).json({ error: 'upstream rpc failure' });
    const peers = result.connections.map(c => ({
      host: c.host,
      port: c.port,
      incoming: c.incoming,
      height: c.height,
      live_time_seconds: c.live_time,
      state: c.state,
      peer_id: c.peer_id,
    }));
    res.json({
      peer_count: peers.length,
      peers,
    });
  });

  return router;
};
