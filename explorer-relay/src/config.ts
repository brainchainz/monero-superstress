const envList = (raw: string | undefined, fallback: string[]): string[] =>
  (raw ?? '').split(',').map(s => s.trim()).filter(Boolean).length
    ? (raw as string).split(',').map(s => s.trim()).filter(Boolean)
    : fallback;

const envNum = (raw: string | undefined, fallback: number): number => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  MONEROD_HOST: process.env.MONEROD_HOST || '127.0.0.1',
  MONEROD_RPC_PORT: envNum(process.env.MONEROD_RPC_PORT, 18081),
  MONEROD_ZMQ_PORT: envNum(process.env.MONEROD_ZMQ_PORT, 18082),

  MONEROD_FALLBACK_NODES: envList(process.env.MONEROD_FALLBACK_NODES, []),

  SERVER_PORT: envNum(process.env.SERVER_PORT, 3001),
  CORS_ORIGINS: envList(process.env.CORS_ORIGINS, ['*']),

  DB_PATH: process.env.DB_PATH || './data/relay.db',
  LOG_LEVEL: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',

  POLL_INTERVAL_MS: envNum(process.env.POLL_INTERVAL_MS, 30_000),
  MEMPOOL_POLL_INTERVAL_MS: envNum(process.env.MEMPOOL_POLL_INTERVAL_MS, 120_000),
  MEMPOOL_POLL_MAX_TXS: envNum(process.env.MEMPOOL_POLL_MAX_TXS, 2_000),
  NETWORK_POLL_MS: envNum(process.env.NETWORK_POLL_MS, 30_000),
  SNAPSHOT_INTERVAL_MS: envNum(process.env.SNAPSHOT_INTERVAL_MS, 60_000),
  BLOCKS_HISTORY: envNum(process.env.BLOCKS_HISTORY, 1_000),

  RPC_TIMEOUT_MS: envNum(process.env.RPC_TIMEOUT_MS, 20_000),

  BLOCK_TARGET_SECONDS: 120,
  PICONERO_PER_XMR: 1_000_000_000_000,
} as const;

export type AppConfig = typeof config;
