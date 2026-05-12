export type FeeTier = 'stuck' | 'economy' | 'normal' | 'fast' | 'priority';

export interface FeeTierDef {
  key: FeeTier;
  max: number;
  color: string;
  label: string;
}

export const FEE_TIERS: readonly FeeTierDef[] = [
  { key: 'stuck',    max: 1,              color: '#444444', label: 'STUCK'    },
  { key: 'economy',  max: 5,              color: '#3D8EFF', label: 'ECONOMY'  },
  { key: 'normal',   max: 20,             color: '#00C97A', label: 'NORMAL'   },
  { key: 'fast',     max: 80,             color: '#F26822', label: 'FAST'     },
  { key: 'priority', max: Number.POSITIVE_INFINITY, color: '#FF4455', label: 'PRIORITY' },
] as const;

export interface XmrMempoolTx {
  txid: string;
  blob_size: number;
  fee: number;
  fee_rate: number;
  receive_time: number;
  relayed: boolean;
  double_spend_seen: boolean;
  do_not_relay: boolean;
  kept_by_block: boolean;
  ring_size: number;
  rct_type: number;
  has_view_tags: boolean;
  unlock_time: number;
  output_count: number;
  input_count: number;
  fee_tier: FeeTier;
}

export interface FeeHistogramBucket {
  fee_rate_min: number;
  fee_rate_max: number;
  tx_count: number;
  bytes: number;
  label: string;
  color: string;
}

export interface ProjectedBlock {
  tx_count: number;
  bytes: number;
  bytes_limit: number;
  fill_pct: number;
  total_fees: number;
  median_fee_rate: number;
  fee_tiers: Record<FeeTier, number>;
}

export interface PoolInfo {
  name: string;
  type: 'decentralized' | 'centralized' | 'solo';
  url: string | null;
}

export interface XmrBlockSummary {
  height: number;
  hash: string;
  timestamp: number;
  reward: number;
  difficulty: number;
  block_weight: number;
  tx_count: number;
  pool_name: string;
  pool_type: string;
  orphan: boolean;
}

export interface XmrBlockDetail extends XmrBlockSummary {
  prev_hash: string;
  nonce: number;
  major_version: number;
  minor_version: number;
  miner_tx_hash: string;
  tx_hashes: string[];
  size: number;
  cumulative_difficulty: number;
}

export interface NetworkState {
  height: number;
  difficulty: number;
  hashrate_ghs: number;
  tx_pool_size: number;
  tx_count_total: number;
  block_weight_limit: number;
  target_seconds: number;
  peer_count: number;
  top_block_hash: string;
  alt_blocks_count: number;
  version: string;
  major_version: number;
  fee_tiers: [number, number, number, number];
}

export interface XmrTxDetail {
  txid: string;
  in_mempool: boolean;
  confirmed: boolean;
  block_height: number | null;
  block_hash: string | null;
  block_timestamp: number | null;
  confirmations: number | null;
  receive_time: number | null;
  blob_size: number;
  fee: number;
  fee_rate: number;
  fee_tier: FeeTier;
  ring_size: number;
  rct_type: number;
  unlock_time: number;
  has_view_tags: boolean;
  output_count: number;
  input_count: number;
  relayed: boolean;
  double_spend_seen: boolean;
}

export interface MempoolUpdatePayload {
  tx_count: number;
  bytes_total: number;
  fees_total: number;
  fee_histogram: FeeHistogramBucket[];
  recent_txs: XmrMempoolTx[];
  projected_block: ProjectedBlock;
  median_fee_rate: number;
}

export interface FeeUpdatePayload {
  tiers: number[];
  recommended: number;
  timestamp: number;
}

export interface PoolBreakdownEntry {
  name: string;
  type: string;
  url: string | null;
  block_count: number;
  share_pct: number;
}

export interface PoolBreakdown {
  window_blocks: number;
  entries: PoolBreakdownEntry[];
}

export interface EmissionData {
  height: number;
  circulating: number;
  tail_emission_per_block: number;
  tail_emission_start_height: number;
  in_tail_emission: boolean;
  blocks_until_tail: number | null;
}

export type WsClientMessage =
  | { action: 'want'; data: Array<'mempool' | 'blocks' | 'fees' | 'network'> }
  | { action: 'track-tx'; txid: string }
  | { action: 'untrack-tx'; txid: string }
  | { action: 'ping' };

export type WsServerMessage =
  | { type: 'mempool-update'; data: MempoolUpdatePayload }
  | { type: 'block'; data: XmrBlockSummary }
  | { type: 'fee-update'; data: FeeUpdatePayload }
  | { type: 'network-update'; data: NetworkState }
  | { type: 'tx-confirmed'; txid: string; block_height: number; block_hash: string }
  | { type: 'hello'; data: { server_version: string; height: number | null } }
  | { type: 'pong' };
