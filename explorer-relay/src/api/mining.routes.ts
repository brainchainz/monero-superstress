import { Router } from 'express';
import type { AppState } from '../state/app-state.js';
import { getRecentBlockStats } from '../db/sqlite.js';
import { getAlternateChains, getCoinbaseTxSum } from '../rpc/monero-rpc.js';
import { MONERO_POOLS } from '../mining/pool-identifier.js';
import type { PoolBreakdown, PoolBreakdownEntry, EmissionData } from '../types.js';
import { config } from '../config.js';

const TAIL_EMISSION_PER_BLOCK = 600_000_000_000; // 0.6 XMR in piconero
const TAIL_EMISSION_START_HEIGHT = 2_641_623;

export const miningRouter = (app: AppState): Router => {
  const router = Router();

  router.get('/pools', (req, res) => {
    const window = Math.max(1, Math.min(10_000, Number(req.query.window) || 1_000));
    const rows = getRecentBlockStats(window);
    const total = rows.length;
    const counts = new Map<string, { type: string; count: number; url: string | null }>();
    for (const row of rows) {
      const existing = counts.get(row.pool_name);
      if (existing) {
        existing.count += 1;
      } else {
        const def = MONERO_POOLS.find(p => p.name === row.pool_name);
        counts.set(row.pool_name, {
          type: row.pool_type,
          count: 1,
          url: def?.url ?? null,
        });
      }
    }
    const entries: PoolBreakdownEntry[] = Array.from(counts.entries())
      .map(([name, info]) => ({
        name,
        type: info.type,
        url: info.url,
        block_count: info.count,
        share_pct: total ? (info.count / total) * 100 : 0,
      }))
      .sort((a, b) => b.block_count - a.block_count);

    const payload: PoolBreakdown = { window_blocks: total, entries };
    res.json(payload);
  });

  return router;
};

export const emissionRouter = (app: AppState): Router => {
  const router = Router();

  router.get('/', async (_req, res) => {
    const height = app.network.height;
    if (!height) return res.status(503).json({ error: 'network state not ready' });

    const sum = await getCoinbaseTxSum(0, height);
    if (!sum) return res.status(502).json({ error: 'upstream rpc failure' });

    const circulating = Number(sum.emission_amount) + Number(sum.fee_amount);
    const inTail = height >= TAIL_EMISSION_START_HEIGHT;
    const payload: EmissionData = {
      height,
      circulating,
      tail_emission_per_block: TAIL_EMISSION_PER_BLOCK,
      tail_emission_start_height: TAIL_EMISSION_START_HEIGHT,
      in_tail_emission: inTail,
      blocks_until_tail: inTail ? null : TAIL_EMISSION_START_HEIGHT - height,
    };
    res.json(payload);
  });

  return router;
};

export const staleRouter = (_app: AppState): Router => {
  const router = Router();
  router.get('/', async (_req, res) => {
    const result = await getAlternateChains();
    if (!result) return res.status(502).json({ error: 'upstream rpc failure' });
    res.json({
      count: result.chains?.length ?? 0,
      chains: result.chains ?? [],
    });
  });
  return router;
};

// satisfy noUnusedParameters
void config;
