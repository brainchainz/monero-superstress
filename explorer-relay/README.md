# xmr-relay

Backend relay server for xmr.irish Mempool 3.0. Bridges monerod ZMQ → WebSocket and
exposes a REST API for blocks, mempool, fees, mining pools and network state.

## Runtime

- Node.js 20+
- TypeScript (ESM / NodeNext)
- Express + ws + zeromq + better-sqlite3

## Ports / Endpoints

| Port | Purpose                           |
|------|-----------------------------------|
| 3001 | HTTP + WebSocket (`/api`, `/ws`)  |

## Environment

Copy `.env.example` to `.env` and adjust. All values have sane defaults.

| Var | Default | Purpose |
|-----|---------|---------|
| `MONEROD_HOST` | `127.0.0.1` | monerod RPC / ZMQ host |
| `MONEROD_RPC_PORT` | `18081` | monerod JSON-RPC port |
| `MONEROD_ZMQ_PORT` | `18082` | monerod ZMQ pub port (`--zmq-pub tcp://127.0.0.1:18082`) |
| `MONEROD_FALLBACK_NODES` | four public nodes | Used if local RPC unreachable |
| `SERVER_PORT` | `3001` | HTTP/WS port |
| `CORS_ORIGINS` | `https://xmr.irish,https://www.xmr.irish,http://localhost:3000,http://localhost:5173` | Allowed origins |
| `DB_PATH` | `./data/relay.db` | SQLite file |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## Scripts

```bash
npm install       # install deps
npm run dev       # tsx watch mode
npm run build     # tsc → dist/
npm start         # node dist/index.js
npm run typecheck # tsc --noEmit
```

## Deployment (PM2)

```bash
cd relay
npm install
npm run build
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Make sure monerod runs with `--zmq-pub tcp://127.0.0.1:18082`.

## REST API

See the M1 handoff document for the full specification. Summary:

```
GET  /health
GET  /api/mempool
GET  /api/mempool/recent?limit=20
GET  /api/mempool/fees
GET  /api/mempool/projected
GET  /api/blocks?limit=10
GET  /api/blocks/tip
GET  /api/blocks/:hashOrHeight
GET  /api/blocks/:hashOrHeight/txs?page=0&limit=25
GET  /api/tx/:txid
GET  /api/tx/:txid/status
POST /api/broadcast              { tx_as_hex }
GET  /api/network
GET  /api/network/hashrate?limit=720
GET  /api/network/difficulty?limit=720
GET  /api/network/peers
GET  /api/mining/pools?window=1000
GET  /api/emission
GET  /api/stale
GET  /api/stats/mempool-history?hours=24
GET  /api/stats/fee-history?hours=24
```

## WebSocket

Connect to `wss://relay.xmr.irish/ws`. Default subscriptions: `mempool`, `blocks`, `fees`.

Client → server:
```json
{ "action": "want", "data": ["mempool","blocks","fees","network"] }
{ "action": "track-tx", "txid": "<64 hex>" }
{ "action": "untrack-tx", "txid": "<64 hex>" }
{ "action": "ping" }
```

Server → client:
```
{ "type": "hello",           "data": { server_version, height } }
{ "type": "mempool-update",  "data": MempoolUpdatePayload }
{ "type": "block",           "data": XmrBlockSummary }
{ "type": "fee-update",      "data": FeeUpdatePayload }
{ "type": "network-update",  "data": NetworkState }
{ "type": "tx-confirmed",    "txid": ..., "block_height": ..., "block_hash": ... }
{ "type": "pong" }
```

## Not implemented (by design)

- Address indexing (impossible in Monero)
- CPFP / RBF (Bitcoin-specific)
- Lightning / Liquid
- MariaDB / Redis (SQLite is sufficient)
- Auth / API keys
