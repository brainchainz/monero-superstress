import { EventEmitter } from 'node:events';
import {
  FEE_TIERS,
  type FeeHistogramBucket,
  type FeeTier,
  type XmrMempoolTx,
} from '../types.js';
import type { ZmqTxPoolAddTx } from '../zmq/zmq-subscriber.js';
import type { TxPoolTx } from '../rpc/monero-rpc.js';
import { createLogger } from '../logger.js';

const log = createLogger('mempool-state');

export const classifyFeeTier = (rate: number): FeeTier => {
  for (const tier of FEE_TIERS) {
    if (rate <= tier.max) return tier.key;
  }
  return 'priority';
};

interface TxJsonShape {
  version?: number;
  unlock_time?: number;
  vin?: Array<{ key?: { key_offsets?: number[] } }>;
  vout?: Array<unknown>;
  rct_signatures?: { type?: number };
  rct_sig_prunable?: unknown;
  extra?: unknown;
}

const parseTxJson = (raw: string | undefined): TxJsonShape => {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as TxJsonShape;
  } catch {
    return {};
  }
};

const ringSize = (tx: TxJsonShape): number => {
  const vin = tx.vin ?? [];
  if (vin.length === 0) return 0;
  const offsets = vin[0]?.key?.key_offsets;
  return Array.isArray(offsets) ? offsets.length : 0;
};

const hasViewTags = (rctType: number): boolean => rctType >= 5;

export interface MempoolStateEvents {
  'tx-added':   (tx: XmrMempoolTx) => void;
  'tx-removed': (txid: string) => void;
  'bulk-change': () => void;
}

export declare interface MempoolState {
  on<K extends keyof MempoolStateEvents>(event: K, listener: MempoolStateEvents[K]): this;
  emit<K extends keyof MempoolStateEvents>(
    event: K,
    ...args: Parameters<MempoolStateEvents[K]>
  ): boolean;
}

export class MempoolState extends EventEmitter {
  private readonly txs = new Map<string, XmrMempoolTx>();

  size(): number { return this.txs.size; }

  has(txid: string): boolean { return this.txs.has(txid); }

  get(txid: string): XmrMempoolTx | undefined { return this.txs.get(txid); }

  getAll(): XmrMempoolTx[] { return Array.from(this.txs.values()); }

  clear(): void {
    if (this.txs.size === 0) return;
    this.txs.clear();
    this.emit('bulk-change');
  }

  addFromZmq(raw: ZmqTxPoolAddTx): XmrMempoolTx | null {
    const tx = this.normalizeZmq(raw);
    if (!tx) return null;
    if (this.txs.has(tx.txid)) return this.txs.get(tx.txid)!;
    this.txs.set(tx.txid, tx);
    this.emit('tx-added', tx);
    return tx;
  }

  addFromRpc(raw: TxPoolTx): XmrMempoolTx | null {
    const tx = this.normalizeRpc(raw);
    if (!tx) return null;
    const existed = this.txs.has(tx.txid);
    this.txs.set(tx.txid, tx);
    if (!existed) this.emit('tx-added', tx);
    return tx;
  }

  removeTxids(ids: readonly string[]): number {
    let removed = 0;
    for (const id of ids) {
      if (this.txs.delete(id)) {
        this.emit('tx-removed', id);
        removed += 1;
      }
    }
    return removed;
  }

  replaceAll(txs: TxPoolTx[]): { added: number; removed: number } {
    const nextIds = new Set<string>();
    let added = 0;
    for (const raw of txs) {
      const tx = this.normalizeRpc(raw);
      if (!tx) continue;
      nextIds.add(tx.txid);
      if (!this.txs.has(tx.txid)) added += 1;
      this.txs.set(tx.txid, tx);
    }
    let removed = 0;
    for (const id of Array.from(this.txs.keys())) {
      if (!nextIds.has(id)) {
        this.txs.delete(id);
        removed += 1;
      }
    }
    if (added || removed) this.emit('bulk-change');
    return { added, removed };
  }

  totalBytes(): number {
    let n = 0;
    for (const tx of this.txs.values()) n += tx.blob_size;
    return n;
  }

  totalFees(): number {
    let n = 0;
    for (const tx of this.txs.values()) n += tx.fee;
    return n;
  }

  medianFeeRate(): number {
    if (this.txs.size === 0) return 0;
    const rates = Array.from(this.txs.values(), t => t.fee_rate).sort((a, b) => a - b);
    const mid = Math.floor(rates.length / 2);
    return rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
  }

  percentileFeeRate(p: number): number {
    if (this.txs.size === 0) return 0;
    const rates = Array.from(this.txs.values(), t => t.fee_rate).sort((a, b) => a - b);
    const idx = Math.min(rates.length - 1, Math.max(0, Math.floor((p / 100) * rates.length)));
    return rates[idx];
  }

  recentTxs(limit: number): XmrMempoolTx[] {
    return Array.from(this.txs.values())
      .sort((a, b) => b.receive_time - a.receive_time)
      .slice(0, limit);
  }

  feeHistogram(): FeeHistogramBucket[] {
    const buckets: Record<FeeTier, FeeHistogramBucket> = Object.create(null);
    let prevMax = 0;
    for (const tier of FEE_TIERS) {
      buckets[tier.key] = {
        fee_rate_min: prevMax,
        fee_rate_max: tier.max,
        tx_count: 0,
        bytes: 0,
        label: tier.label,
        color: tier.color,
      };
      prevMax = tier.max;
    }
    for (const tx of this.txs.values()) {
      const bucket = buckets[tx.fee_tier];
      bucket.tx_count += 1;
      bucket.bytes += tx.blob_size;
    }
    return FEE_TIERS.map(t => buckets[t.key]);
  }

  private normalizeZmq(raw: ZmqTxPoolAddTx): XmrMempoolTx | null {
    const txid = raw.id_hash;
    if (!txid || typeof txid !== 'string') return null;
    const blob_size = Number(raw.blob_size) || 0;
    const fee = Number(raw.fee) || 0;
    if (blob_size <= 0) return null;
    const feeRate = fee / blob_size;
    const json = parseTxJson(raw.tx_json);
    const rctType = Number(json.rct_signatures?.type ?? 0);
    const outputs = Array.isArray(json.vout) ? json.vout.length : 0;
    const inputs = Array.isArray(json.vin) ? json.vin.length : 0;
    const rs = ringSize(json);

    return {
      txid,
      blob_size,
      fee,
      fee_rate: feeRate,
      receive_time: Number(raw.receive_time) || Math.floor(Date.now() / 1000),
      relayed: Boolean(raw.relayed),
      double_spend_seen: Boolean(raw.double_spend_seen),
      do_not_relay: Boolean(raw.do_not_relay),
      kept_by_block: Boolean(raw.kept_by_block),
      ring_size: rs,
      rct_type: rctType,
      has_view_tags: hasViewTags(rctType),
      unlock_time: Number(json.unlock_time ?? 0),
      output_count: outputs,
      input_count: inputs,
      fee_tier: classifyFeeTier(feeRate),
    };
  }

  private normalizeRpc(raw: TxPoolTx): XmrMempoolTx | null {
    const txid = raw.id_hash;
    if (!txid) return null;
    const blob_size = Number(raw.blob_size) || 0;
    const fee = Number(raw.fee) || 0;
    if (blob_size <= 0) {
      log.debug(`skip rpc tx ${txid} with blob_size=0`);
      return null;
    }
    const feeRate = fee / blob_size;
    const json = parseTxJson(raw.tx_json);
    const rctType = Number(json.rct_signatures?.type ?? 0);
    const outputs = Array.isArray(json.vout) ? json.vout.length : 0;
    const inputs = Array.isArray(json.vin) ? json.vin.length : 0;
    const rs = ringSize(json);

    return {
      txid,
      blob_size,
      fee,
      fee_rate: feeRate,
      receive_time: Number(raw.receive_time) || Math.floor(Date.now() / 1000),
      relayed: Boolean(raw.relayed),
      double_spend_seen: Boolean(raw.double_spend_seen),
      do_not_relay: Boolean(raw.do_not_relay),
      kept_by_block: Boolean(raw.kept_by_block),
      ring_size: rs,
      rct_type: rctType,
      has_view_tags: hasViewTags(rctType),
      unlock_time: Number(json.unlock_time ?? 0),
      output_count: outputs,
      input_count: inputs,
      fee_tier: classifyFeeTier(feeRate),
    };
  }
}
