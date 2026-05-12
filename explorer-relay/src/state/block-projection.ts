import type { FeeTier, ProjectedBlock, XmrMempoolTx } from '../types.js';
import { FEE_TIERS } from '../types.js';

const DEFAULT_BLOCK_WEIGHT_LIMIT = 300_000;

export const projectNextBlock = (
  txs: readonly XmrMempoolTx[],
  blockWeightLimit?: number,
): ProjectedBlock => {
  const limit = blockWeightLimit && blockWeightLimit > 0
    ? blockWeightLimit
    : DEFAULT_BLOCK_WEIGHT_LIMIT;

  const sorted = [...txs].sort((a, b) => b.fee_rate - a.fee_rate);

  const inBlock: XmrMempoolTx[] = [];
  let bytes = 0;
  let fees = 0;
  const tierBytes: Record<FeeTier, number> = {
    stuck: 0, economy: 0, normal: 0, fast: 0, priority: 0,
  };

  for (const tx of sorted) {
    if (bytes + tx.blob_size > limit) continue;
    inBlock.push(tx);
    bytes += tx.blob_size;
    fees += tx.fee;
    tierBytes[tx.fee_tier] += tx.blob_size;
  }

  let medianRate = 0;
  if (inBlock.length) {
    const rates = inBlock.map(t => t.fee_rate).sort((a, b) => a - b);
    const mid = Math.floor(rates.length / 2);
    medianRate = rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
  }

  return {
    tx_count: inBlock.length,
    bytes,
    bytes_limit: limit,
    fill_pct: limit > 0 ? Math.min(100, (bytes / limit) * 100) : 0,
    total_fees: fees,
    median_fee_rate: medianRate,
    fee_tiers: tierBytes,
  };
};

export const emptyProjectedBlock = (blockWeightLimit?: number): ProjectedBlock => ({
  tx_count: 0,
  bytes: 0,
  bytes_limit: blockWeightLimit && blockWeightLimit > 0 ? blockWeightLimit : DEFAULT_BLOCK_WEIGHT_LIMIT,
  fill_pct: 0,
  total_fees: 0,
  median_fee_rate: 0,
  fee_tiers: FEE_TIERS.reduce((acc, t) => {
    acc[t.key] = 0;
    return acc;
  }, {} as Record<FeeTier, number>),
});
