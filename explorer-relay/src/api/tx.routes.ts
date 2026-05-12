import { Router, type RequestHandler } from 'express';
import type { AppState } from '../state/app-state.js';
import { getTransactions, sendRawTransaction } from '../rpc/monero-rpc.js';
import { classifyFeeTier } from '../state/mempool-state.js';
import type { XmrTxDetail } from '../types.js';

const HEX64 = /^[0-9a-fA-F]{64}$/;

interface TxAsJson {
  version?: number;
  unlock_time?: number;
  vin?: Array<{ key?: { key_offsets?: number[] } }>;
  vout?: unknown[];
  rct_signatures?: { type?: number };
}

const parseAsJson = (raw: string | undefined): TxAsJson => {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as TxAsJson;
  } catch {
    return {};
  }
};

export const broadcastHandler: RequestHandler = async (req, res) => {
  const body = (req.body ?? {}) as { tx_as_hex?: unknown };
  const hex = typeof body.tx_as_hex === 'string' ? body.tx_as_hex.trim() : '';
  if (!hex || !/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
    res.status(400).json({ error: 'tx_as_hex must be even-length hex string' });
    return;
  }
  if (hex.length > 2_000_000) {
    res.status(413).json({ error: 'transaction too large' });
    return;
  }
  const result = await sendRawTransaction(hex);
  if (!result) {
    res.status(502).json({ error: 'upstream rpc failure' });
    return;
  }
  if (result.status === 'OK') {
    res.json({ status: 'OK' });
    return;
  }
  res.status(400).json({
    error: 'rejected',
    reason: result.reason || result.status,
    flags: {
      not_relayed: result.not_relayed,
      low_mixin: result.low_mixin,
      double_spend: result.double_spend,
      invalid_input: result.invalid_input,
      invalid_output: result.invalid_output,
      too_big: result.too_big,
      overspend: result.overspend,
      fee_too_low: result.fee_too_low,
    },
  });
};

export const txRouter = (app: AppState): Router => {
  const router = Router();

  router.get('/:txid', async (req, res) => {
    const txid = req.params.txid.toLowerCase();
    if (!HEX64.test(txid)) {
      res.status(400).json({ error: 'invalid txid' });
      return;
    }

    const inMempool = app.mempool.get(txid);
    if (inMempool) {
      const detail: XmrTxDetail = {
        txid,
        in_mempool: true,
        confirmed: false,
        block_height: null,
        block_hash: null,
        block_timestamp: null,
        confirmations: 0,
        receive_time: inMempool.receive_time,
        blob_size: inMempool.blob_size,
        fee: inMempool.fee,
        fee_rate: inMempool.fee_rate,
        fee_tier: inMempool.fee_tier,
        ring_size: inMempool.ring_size,
        rct_type: inMempool.rct_type,
        unlock_time: inMempool.unlock_time,
        has_view_tags: inMempool.has_view_tags,
        output_count: inMempool.output_count,
        input_count: inMempool.input_count,
        relayed: inMempool.relayed,
        double_spend_seen: inMempool.double_spend_seen,
      };
      res.json(detail);
      return;
    }

    const result = await getTransactions([txid]);
    const first = result?.txs?.[0];
    if (!first) {
      res.status(404).json({ error: 'transaction not found' });
      return;
    }

    const json = parseAsJson(first.as_json ?? first.tx_entry_json);
    const blobSize = first.as_hex ? first.as_hex.length / 2 : 0;
    const feeRate = 0;
    const rctType = Number(json.rct_signatures?.type ?? 0);
    const ringSize = Array.isArray(json.vin) && json.vin[0]?.key?.key_offsets
      ? json.vin[0].key.key_offsets.length
      : 0;

    const detail: XmrTxDetail = {
      txid,
      in_mempool: Boolean(first.in_pool),
      confirmed: !first.in_pool,
      block_height: first.block_height ?? null,
      block_hash: null,
      block_timestamp: first.block_timestamp ?? null,
      confirmations: first.confirmations ?? null,
      receive_time: first.received_timestamp ?? null,
      blob_size: blobSize,
      fee: 0,
      fee_rate: feeRate,
      fee_tier: classifyFeeTier(feeRate),
      ring_size: ringSize,
      rct_type: rctType,
      unlock_time: Number(json.unlock_time ?? 0),
      has_view_tags: rctType >= 5,
      output_count: Array.isArray(json.vout) ? json.vout.length : 0,
      input_count: Array.isArray(json.vin) ? json.vin.length : 0,
      relayed: first.relayed ?? true,
      double_spend_seen: first.double_spend_seen ?? false,
    };
    res.json(detail);
  });

  router.get('/:txid/status', async (req, res) => {
    const txid = req.params.txid.toLowerCase();
    if (!HEX64.test(txid)) {
      res.status(400).json({ error: 'invalid txid' });
      return;
    }

    if (app.mempool.has(txid)) {
      res.json({ in_mempool: true, confirmed: false, block_height: null });
      return;
    }

    const result = await getTransactions([txid]);
    const first = result?.txs?.[0];
    if (!first) {
      res.json({ in_mempool: false, confirmed: false, block_height: null });
      return;
    }

    res.json({
      in_mempool: Boolean(first.in_pool),
      confirmed: !first.in_pool,
      block_height: first.block_height ?? null,
      confirmations: first.confirmations ?? null,
    });
  });

  return router;
};
