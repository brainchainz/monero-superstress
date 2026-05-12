import type { PoolInfo } from '../types.js';

interface PoolDef {
  name: string;
  tags: string[];
  url: string | null;
  type: 'decentralized' | 'centralized' | 'solo';
}

export const MONERO_POOLS: readonly PoolDef[] = [
  { name: 'P2Pool',        tags: ['p2pool', 'P2Pool'],                    url: 'https://p2pool.io',            type: 'decentralized' },
  { name: 'SupportXMR',    tags: ['SupportXMR', 'supportxmr'],            url: 'https://supportxmr.com',       type: 'centralized'   },
  { name: 'MoneroOcean',   tags: ['MoneroOcean', 'moneroocean'],          url: 'https://moneroocean.stream',    type: 'centralized'   },
  { name: 'Nanopool',      tags: ['nanopool', 'xmr.nanopool'],            url: 'https://xmr.nanopool.org',     type: 'centralized'   },
  { name: 'HashVault',     tags: ['hashvault', 'HashVault'],              url: 'https://monero.hashvault.pro',  type: 'centralized'   },
  { name: '2Miners',       tags: ['2miners', '2Miners'],                  url: 'https://xmr.2miners.com',      type: 'centralized'   },
  { name: 'C3Pool',        tags: ['c3pool', 'C3Pool'],                    url: 'https://c3pool.com',           type: 'centralized'   },
  { name: 'MineXMR',       tags: ['mxmr', 'minexmr'],                     url: null,                           type: 'centralized'   },
  { name: 'Solo / Unknown', tags: [],                                     url: null,                           type: 'solo'          },
] as const;

const hexToUtf8 = (hex: string): string => {
  if (!hex) return '';
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length < 2) return '';
  try {
    return Buffer.from(clean, 'hex').toString('utf8');
  } catch {
    return '';
  }
};

export const identifyPoolFromExtra = (extraHex: string): PoolInfo => {
  const text = hexToUtf8(extraHex);
  if (text) {
    for (const pool of MONERO_POOLS) {
      if (pool.tags.length === 0) continue;
      if (pool.tags.some(tag => text.includes(tag))) {
        return { name: pool.name, type: pool.type, url: pool.url };
      }
    }
  }
  const fallback = MONERO_POOLS[MONERO_POOLS.length - 1];
  return { name: fallback.name, type: fallback.type, url: fallback.url };
};

export const identifyPoolFromCoinbase = (minerTx: unknown): PoolInfo => {
  const tx = minerTx as { extra?: number[] | string } | null;
  if (!tx) return identifyPoolFromExtra('');
  if (Array.isArray(tx.extra)) {
    const hex = Buffer.from(tx.extra).toString('hex');
    return identifyPoolFromExtra(hex);
  }
  if (typeof tx.extra === 'string') {
    return identifyPoolFromExtra(tx.extra);
  }
  return identifyPoolFromExtra('');
};
