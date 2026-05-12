import { config } from '../config.js';
import { createLogger } from '../logger.js';
import {
  getFeeEstimate,
  getInfo,
  getConnections,
} from '../rpc/monero-rpc.js';
import type { NetworkState } from '../types.js';

const log = createLogger('network-state');

const EMPTY: NetworkState = {
  height: 0,
  difficulty: 0,
  hashrate_ghs: 0,
  tx_pool_size: 0,
  tx_count_total: 0,
  block_weight_limit: 0,
  target_seconds: config.BLOCK_TARGET_SECONDS,
  peer_count: 0,
  top_block_hash: '',
  alt_blocks_count: 0,
  version: '',
  major_version: 0,
  fee_tiers: [0, 0, 0, 0],
};

const parseMajorVersion = (version: string): number => {
  if (!version) return 0;
  const first = version.split('.').shift();
  const n = Number(first);
  return Number.isFinite(n) ? n : 0;
};

export class NetworkStateCache {
  private current: NetworkState = { ...EMPTY };
  private timer: NodeJS.Timeout | null = null;
  private lastRefresh = 0;

  get(): NetworkState { return this.current; }

  get height(): number { return this.current.height; }
  get blockWeightLimit(): number { return this.current.block_weight_limit; }

  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, config.NETWORK_POLL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  async refresh(): Promise<NetworkState> {
    try {
      const info = await getInfo();
      if (!info) return this.current;

      // These are nice-to-have and can time out under stressnet load. Do not let
      // fee/connection RPCs make the whole network cache stale.
      const [fee, conns] = await Promise.all([
        getFeeEstimate().catch(() => null),
        getConnections().catch(() => null),
      ]);

      const feeTiers: [number, number, number, number] =
        Array.isArray(fee?.fees) && fee!.fees!.length >= 4
          ? [fee!.fees![0], fee!.fees![1], fee!.fees![2], fee!.fees![3]]
          : this.current.fee_tiers;

      const difficulty = Number(info.difficulty) || 0;
      const hashrateGhs = difficulty / config.BLOCK_TARGET_SECONDS / 1_000_000_000;

      this.current = {
        height: Number(info.height) || 0,
        difficulty,
        hashrate_ghs: hashrateGhs,
        tx_pool_size: Number(info.tx_pool_size) || 0,
        tx_count_total: Number(info.tx_count) || 0,
        block_weight_limit: Number(info.block_weight_limit) || Number(info.block_size_limit) || 0,
        target_seconds: Number(info.target) || config.BLOCK_TARGET_SECONDS,
        peer_count:
          (Number(info.incoming_connections_count) || 0) +
          (Number(info.outgoing_connections_count) || 0),
        top_block_hash: String(info.top_block_hash || ''),
        alt_blocks_count: Number(info.alt_blocks_count) || 0,
        version: String(info.version || ''),
        major_version: parseMajorVersion(String(info.version || '')),
        fee_tiers: feeTiers,
      };
      this.lastRefresh = Date.now();
      return this.current;
    } catch (err) {
      log.warn(`refresh failed: ${(err as Error).message}`);
      return this.current;
    }
  }

  stale(thresholdMs: number = config.NETWORK_POLL_MS * 3): boolean {
    return Date.now() - this.lastRefresh > thresholdMs;
  }
}
