import { EventEmitter } from 'node:events';
import { MempoolState } from './mempool-state.js';
import { NetworkStateCache } from './network-state.js';
import { BlockHistoryService } from './block-history.js';
import { ZmqSubscriber } from '../zmq/zmq-subscriber.js';
import { getTransactionPool } from '../rpc/monero-rpc.js';
import { projectNextBlock } from './block-projection.js';
import { config } from '../config.js';
import { createLogger } from '../logger.js';
import {
  insertFeeSnapshot,
  insertMempoolSnapshot,
  pruneFeeSnapshots,
  pruneMempoolSnapshots,
} from '../db/sqlite.js';
import type {
  FeeUpdatePayload,
  MempoolUpdatePayload,
  XmrBlockSummary,
} from '../types.js';

const log = createLogger('app-state');

export interface AppStateEvents {
  'mempool-update': (payload: MempoolUpdatePayload) => void;
  'block':          (block: XmrBlockSummary) => void;
  'fee-update':     (payload: FeeUpdatePayload) => void;
  'tx-confirmed':   (payload: { txid: string; block_height: number; block_hash: string }) => void;
}

export declare interface AppState {
  on<K extends keyof AppStateEvents>(event: K, listener: AppStateEvents[K]): this;
  emit<K extends keyof AppStateEvents>(event: K, ...args: Parameters<AppStateEvents[K]>): boolean;
}

const MEMPOOL_UPDATE_THROTTLE_MS = 750;
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

export class AppState extends EventEmitter {
  readonly mempool = new MempoolState();
  readonly network = new NetworkStateCache();
  readonly blockHistory = new BlockHistoryService();
  readonly zmq = new ZmqSubscriber();

  private mempoolUpdateTimer: NodeJS.Timeout | null = null;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastMempoolPollAt = 0;
  private consecutiveMempoolFailures = 0;
  private resyncInFlight = false;

  async start(): Promise<void> {
    this.network.start();
    await this.network.refresh();
    await this.blockHistory.bootstrap();
    await this.primeMempool();

    this.zmq.on('connected', () => log.info('zmq connected'));
    this.zmq.on('disconnected', reason => log.warn(`zmq disconnected: ${reason}`));

    this.zmq.on('new-tx', raw => {
      const tx = this.mempool.addFromZmq(raw);
      if (tx) this.scheduleMempoolUpdate();
    });

    this.zmq.on('new-block', async ({ block }) => {
      try {
        const hashOrHeight = typeof block._height === 'number'
          ? { height: block._height }
          : undefined;
        const summary = hashOrHeight
          ? await this.blockHistory.onNewBlockByHeight(hashOrHeight.height!)
          : await this.blockHistory.onNewBlockByHash(block._hash || '');

        if (summary) {
          this.emit('block', summary);
          const removedIds = (block.tx_hashes || []).filter(Boolean);
          const confirmedTxids: string[] = [];
          for (const id of removedIds) {
            if (this.mempool.has(id)) confirmedTxids.push(id);
          }
          this.mempool.removeTxids(removedIds);
          for (const txid of confirmedTxids) {
            this.emit('tx-confirmed', {
              txid,
              block_height: summary.height,
              block_hash: summary.hash,
            });
          }
          await this.network.refresh();
          this.scheduleMempoolUpdate();
          this.emitFeeUpdate();
        } else {
          // ZMQ payload didn't identify block; fall back to resync
          await this.resyncFromRpc();
        }
      } catch (err) {
        log.error(`block handler error: ${(err as Error).message}`);
      }
    });

    await this.zmq.start().catch(err => log.warn(`zmq start failed: ${err.message}`));

    // Fallback poll — keeps relay alive even if ZMQ is silent
    this.pollTimer = setInterval(() => {
      void this.resyncFromRpc();
    }, config.POLL_INTERVAL_MS);

    // Historical snapshots
    this.snapshotTimer = setInterval(() => {
      this.writeSnapshots();
    }, config.SNAPSHOT_INTERVAL_MS);

    this.emitMempoolUpdate();
    this.emitFeeUpdate();
  }

  async stop(): Promise<void> {
    if (this.mempoolUpdateTimer) clearTimeout(this.mempoolUpdateTimer);
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.network.stop();
    await this.zmq.stop();
  }

  buildMempoolPayload(): MempoolUpdatePayload {
    const all = this.mempool.getAll();
    return {
      tx_count: this.mempool.size(),
      bytes_total: this.mempool.totalBytes(),
      fees_total: this.mempool.totalFees(),
      fee_histogram: this.mempool.feeHistogram(),
      recent_txs: this.mempool.recentTxs(20),
      projected_block: projectNextBlock(all, this.network.blockWeightLimit),
      median_fee_rate: this.mempool.medianFeeRate(),
    };
  }

  buildFeePayload(): FeeUpdatePayload {
    const tiers = this.network.get().fee_tiers;
    const recommended = tiers[1] || tiers[0] || 0;
    return {
      tiers: [...tiers],
      recommended,
      timestamp: Math.floor(Date.now() / 1000),
    };
  }

  private async primeMempool(): Promise<void> {
    const pool = await getTransactionPool();
    if (!pool?.transactions) {
      log.warn('prime mempool: no transactions from rpc');
      return;
    }
    const { added, removed } = this.mempool.replaceAll(pool.transactions);
    log.info(`primed mempool: +${added} −${removed} total=${this.mempool.size()}`);
  }

  private async resyncFromRpc(): Promise<void> {
    if (this.resyncInFlight) {
      log.debug('resync skipped: previous poll still running');
      return;
    }
    this.resyncInFlight = true;
    try {
      await this.network.refresh().catch(err => log.debug(`network refresh failed: ${(err as Error).message}`));

      const now = Date.now();
      const backoff = Math.min(this.consecutiveMempoolFailures, 5) * config.MEMPOOL_POLL_INTERVAL_MS;
      const mempoolDue = now - this.lastMempoolPollAt >= config.MEMPOOL_POLL_INTERVAL_MS + backoff;
      const poolSize = this.network.get().tx_pool_size || this.mempool.size();

      if (mempoolDue && poolSize <= config.MEMPOOL_POLL_MAX_TXS) {
        this.lastMempoolPollAt = now;
        try {
          const pool = await getTransactionPool();
          if (pool?.transactions) {
            const result = this.mempool.replaceAll(pool.transactions);
            this.consecutiveMempoolFailures = 0;
            if (result.added || result.removed) {
              log.debug(`resync changed +${result.added} −${result.removed}`);
              this.scheduleMempoolUpdate();
            }
          }
        } catch (err) {
          this.consecutiveMempoolFailures += 1;
          log.warn(`mempool poll skipped after failure #${this.consecutiveMempoolFailures}: ${(err as Error).message}`);
        }
      } else if (poolSize > config.MEMPOOL_POLL_MAX_TXS) {
        log.debug(`mempool poll skipped: pool size ${poolSize} > ${config.MEMPOOL_POLL_MAX_TXS}`);
      }

      // Also sync blocks in fallback — ZMQ may miss chain_main events. This is cheap
      // compared to full get_transaction_pool and keeps explorer blocks current.
      const newBlocks = await this.blockHistory.syncFromRpc();
      for (const summary of newBlocks) this.emit('block', summary);
      if (newBlocks.length) {
        this.scheduleMempoolUpdate();
        this.emitFeeUpdate();
      }
    } catch (err) {
      log.warn(`resync failed: ${(err as Error).message}`);
    } finally {
      this.resyncInFlight = false;
    }
  }

  private scheduleMempoolUpdate(): void {
    if (this.mempoolUpdateTimer) return;
    this.mempoolUpdateTimer = setTimeout(() => {
      this.mempoolUpdateTimer = null;
      this.emitMempoolUpdate();
    }, MEMPOOL_UPDATE_THROTTLE_MS);
  }

  private emitMempoolUpdate(): void {
    this.emit('mempool-update', this.buildMempoolPayload());
  }

  private emitFeeUpdate(): void {
    this.emit('fee-update', this.buildFeePayload());
  }

  private writeSnapshots(): void {
    const timestamp = Math.floor(Date.now() / 1000);
    try {
      insertMempoolSnapshot({
        timestamp,
        tx_count: this.mempool.size(),
        bytes_total: this.mempool.totalBytes(),
        fee_total: this.mempool.totalFees(),
        median_fee_rate: this.mempool.medianFeeRate(),
        p98_fee_rate: this.mempool.percentileFeeRate(98),
      });
      const tiers = this.network.get().fee_tiers;
      insertFeeSnapshot({
        timestamp,
        fee_slow: tiers[0],
        fee_normal: tiers[1],
        fee_fast: tiers[2],
        fee_fastest: tiers[3],
      });
      pruneMempoolSnapshots(timestamp - SEVEN_DAYS_SECONDS);
      pruneFeeSnapshots(timestamp - SEVEN_DAYS_SECONDS);
    } catch (err) {
      log.warn(`snapshot write failed: ${(err as Error).message}`);
    }
  }
}
