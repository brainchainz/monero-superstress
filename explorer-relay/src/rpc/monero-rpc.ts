import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('rpc');

interface JsonRpcEnvelope<T> {
  jsonrpc: '2.0';
  id: string;
  result?: T;
  error?: { code: number; message: string };
}

type JsonRecord = Record<string, unknown>;

const nodeBases = (): string[] => {
  const local = `http://${config.MONEROD_HOST}:${config.MONEROD_RPC_PORT}`;
  return [local, ...config.MONEROD_FALLBACK_NODES];
};

const timeoutSignal = (ms: number): AbortSignal => AbortSignal.timeout(ms);

const postJson = async <T>(url: string, body: unknown): Promise<T> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: timeoutSignal(config.RPC_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
};

const jsonRpc = async <T>(method: string, params: JsonRecord = {}): Promise<T | null> => {
  let lastErr: unknown = null;
  for (const base of nodeBases()) {
    try {
      const env = await postJson<JsonRpcEnvelope<T>>(`${base}/json_rpc`, {
        jsonrpc: '2.0',
        id: '0',
        method,
        params,
      });
      if (env.error) throw new Error(`RPC error ${env.error.code}: ${env.error.message}`);
      if (env.result === undefined) throw new Error('RPC response missing result');
      return env.result;
    } catch (err) {
      lastErr = err;
      log.warn(`json_rpc ${method} failed via ${base}: ${(err as Error).message}`);
    }
  }
  log.error(`json_rpc ${method} exhausted all nodes`, (lastErr as Error)?.message);
  return null;
};

const directCall = async <T>(path: string, body: unknown = {}): Promise<T | null> => {
  let lastErr: unknown = null;
  for (const base of nodeBases()) {
    try {
      return await postJson<T>(`${base}${path}`, body);
    } catch (err) {
      lastErr = err;
      log.warn(`${path} failed via ${base}: ${(err as Error).message}`);
    }
  }
  log.error(`${path} exhausted all nodes`, (lastErr as Error)?.message);
  return null;
};

export interface GetInfoResult {
  height: number;
  difficulty: number;
  tx_pool_size: number;
  tx_count: number;
  block_weight_limit?: number;
  block_size_limit?: number;
  incoming_connections_count: number;
  outgoing_connections_count: number;
  top_block_hash: string;
  alt_blocks_count: number;
  version: string;
  status: string;
  target: number;
}

export interface GetBlockResult {
  block_header: {
    block_size?: number;
    block_weight?: number;
    cumulative_difficulty?: number;
    depth: number;
    difficulty: number;
    hash: string;
    height: number;
    major_version: number;
    minor_version: number;
    miner_tx_hash: string;
    nonce: number;
    num_txes: number;
    orphan_status: boolean;
    prev_hash: string;
    reward: number;
    timestamp: number;
  };
  blob: string;
  json: string;
  miner_tx_hash: string;
  tx_hashes?: string[];
  status: string;
}

export interface BlockHeader {
  block_size?: number;
  block_weight?: number;
  cumulative_difficulty?: number;
  depth: number;
  difficulty: number;
  hash: string;
  height: number;
  major_version: number;
  minor_version: number;
  miner_tx_hash: string;
  nonce: number;
  num_txes: number;
  orphan_status: boolean;
  prev_hash: string;
  reward: number;
  timestamp: number;
}

export interface TxPoolTx {
  id_hash: string;
  tx_json: string;
  blob_size: number;
  weight?: number;
  fee: number;
  kept_by_block: boolean;
  max_used_block_height: number;
  max_used_block_id_hash: string;
  last_failed_height: number;
  last_failed_id_hash: string;
  receive_time: number;
  relayed: boolean;
  last_relayed_time: number;
  do_not_relay: boolean;
  double_spend_seen: boolean;
}

export interface TxPoolStats {
  pool_stats: {
    bytes_max: number;
    bytes_med: number;
    bytes_min: number;
    bytes_total: number;
    fee_total: number;
    histo?: Array<{ bytes: number; txs: number }>;
    histo_98pc?: number;
    num_10m: number;
    num_double_spends: number;
    num_failing: number;
    num_not_relayed: number;
    oldest: number;
    txs_total: number;
  };
  status: string;
}

export interface ConnectionInfo {
  address: string;
  host: string;
  port: number;
  incoming: boolean;
  peer_id: string;
  connection_id: string;
  rpc_credits_per_hash: number;
  current_download: number;
  current_upload: number;
  height: number;
  live_time: number;
  state: string;
  support_flags: number;
}

export interface AlternateChain {
  block_hash: string;
  difficulty: number;
  height: number;
  length: number;
  main_chain_parent_block: string;
}

export interface CoinbaseTxSum {
  emission_amount: number;
  fee_amount: number;
  top_hash: string;
  wide_emission_amount: string;
  wide_fee_amount: string;
  status: string;
}

export interface FeeEstimate {
  fee: number;
  fees?: number[];
  quantization_mask?: number;
  status: string;
}

export const getInfo = () => jsonRpc<GetInfoResult>('get_info');

export const getLastBlockHeader = () =>
  jsonRpc<{ block_header: BlockHeader }>('get_last_block_header');

export const getBlock = (arg: { hash?: string; height?: number }) => {
  const params: JsonRecord = {};
  if (arg.hash) params.hash = arg.hash;
  if (typeof arg.height === 'number') params.height = arg.height;
  return jsonRpc<GetBlockResult>('get_block', params);
};

export const getBlockHeadersRange = (startHeight: number, endHeight: number) =>
  jsonRpc<{ headers: BlockHeader[] }>('get_block_headers_range', {
    start_height: startHeight,
    end_height: endHeight,
  });

export const getFeeEstimate = (graceBlocks = 0) =>
  jsonRpc<FeeEstimate>('get_fee_estimate', graceBlocks ? { grace_blocks: graceBlocks } : {});

export const getAlternateChains = () =>
  jsonRpc<{ chains?: AlternateChain[] }>('get_alternate_chains');

export const getConnections = () =>
  jsonRpc<{ connections: ConnectionInfo[] }>('get_connections');

export const getCoinbaseTxSum = (height: number, count: number) =>
  jsonRpc<CoinbaseTxSum>('get_coinbase_tx_sum', { height, count });

export const getTransactionPool = () =>
  directCall<{ transactions?: TxPoolTx[]; status: string }>('/get_transaction_pool');

export const getTransactionPoolStats = () =>
  directCall<TxPoolStats>('/get_transaction_pool_stats');

export interface GetTransactionsResult {
  txs?: Array<{
    tx_hash: string;
    in_pool: boolean;
    block_height?: number;
    block_timestamp?: number;
    confirmations?: number;
    tx_entry_json?: string;
    as_json?: string;
    as_hex?: string;
    pruned_as_hex?: string;
    prunable_as_hex?: string;
    prunable_hash?: string;
    double_spend_seen?: boolean;
    received_timestamp?: number;
    relayed?: boolean;
  }>;
  status: string;
}

export const getTransactions = (txHashes: string[]) =>
  directCall<GetTransactionsResult>('/get_transactions', {
    txs_hashes: txHashes,
    decode_as_json: true,
  });

export interface BroadcastResult {
  status: string;
  reason?: string;
  not_relayed?: boolean;
  low_mixin?: boolean;
  double_spend?: boolean;
  invalid_input?: boolean;
  invalid_output?: boolean;
  too_big?: boolean;
  overspend?: boolean;
  fee_too_low?: boolean;
}

export const sendRawTransaction = (txAsHex: string, doNotRelay = false) =>
  directCall<BroadcastResult>('/send_raw_transaction', {
    tx_as_hex: txAsHex,
    do_not_relay: doNotRelay,
  });
