import { Router } from 'express';
import type { AppState } from '../state/app-state.js';
import {
  getFeeSnapshotsSince,
  getMempoolSnapshotsSince,
} from '../db/sqlite.js';

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 7 * 24;

const parseWindow = (raw: unknown): number => {
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) return DEFAULT_WINDOW_HOURS;
  return Math.min(MAX_WINDOW_HOURS, hours);
};

export const statsRouter = (_app: AppState): Router => {
  const router = Router();

  router.get('/mempool-history', (req, res) => {
    const hours = parseWindow(req.query.hours);
    const since = Math.floor(Date.now() / 1000) - hours * 3600;
    res.json({
      window_hours: hours,
      snapshots: getMempoolSnapshotsSince(since),
    });
  });

  router.get('/fee-history', (req, res) => {
    const hours = parseWindow(req.query.hours);
    const since = Math.floor(Date.now() / 1000) - hours * 3600;
    res.json({
      window_hours: hours,
      snapshots: getFeeSnapshotsSince(since),
    });
  });

  return router;
};
