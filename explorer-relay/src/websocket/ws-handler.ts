import { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Server as HttpServer } from 'node:http';
import type { AppState } from '../state/app-state.js';
import { createLogger } from '../logger.js';
import type {
  FeeUpdatePayload,
  MempoolUpdatePayload,
  WsClientMessage,
  WsServerMessage,
  XmrBlockSummary,
} from '../types.js';

const log = createLogger('ws');

type Channel = 'mempool' | 'blocks' | 'fees' | 'network';
const VALID_CHANNELS: readonly Channel[] = ['mempool', 'blocks', 'fees', 'network'];
const HEX64 = /^[0-9a-fA-F]{64}$/;

interface ClientContext {
  socket: WebSocket;
  channels: Set<Channel>;
  trackedTxids: Set<string>;
  aliveAt: number;
}

const send = (client: ClientContext, msg: WsServerMessage): void => {
  if (client.socket.readyState !== WebSocket.OPEN) return;
  try {
    client.socket.send(JSON.stringify(msg));
  } catch (err) {
    log.warn(`send failed: ${(err as Error).message}`);
  }
};

const parseClientMessage = (raw: string): WsClientMessage | null => {
  try {
    const parsed = JSON.parse(raw) as WsClientMessage;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.action !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
};

const SERVER_VERSION = '1.0.0';

export const attachWebSocketServer = (
  httpServer: HttpServer,
  app: AppState,
): WebSocketServer => {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const clients = new Set<ClientContext>();

  wss.on('connection', (socket: WebSocket, _req: IncomingMessage) => {
    const ctx: ClientContext = {
      socket,
      channels: new Set<Channel>(['mempool', 'blocks', 'fees']),
      trackedTxids: new Set<string>(),
      aliveAt: Date.now(),
    };
    clients.add(ctx);
    log.debug(`client connected (total=${clients.size})`);

    send(ctx, {
      type: 'hello',
      data: { server_version: SERVER_VERSION, height: app.network.get().height || null },
    });
    send(ctx, { type: 'mempool-update', data: app.buildMempoolPayload() });
    send(ctx, { type: 'fee-update', data: app.buildFeePayload() });
    send(ctx, { type: 'network-update', data: app.network.get() });

    socket.on('message', data => {
      const raw = typeof data === 'string' ? data : data.toString('utf8');
      const msg = parseClientMessage(raw);
      if (!msg) return;
      ctx.aliveAt = Date.now();

      switch (msg.action) {
        case 'want':
          ctx.channels.clear();
          if (Array.isArray(msg.data)) {
            for (const ch of msg.data) {
              if ((VALID_CHANNELS as readonly string[]).includes(ch)) {
                ctx.channels.add(ch as Channel);
              }
            }
          }
          break;
        case 'track-tx':
          if (typeof msg.txid === 'string' && HEX64.test(msg.txid)) {
            ctx.trackedTxids.add(msg.txid.toLowerCase());
          }
          break;
        case 'untrack-tx':
          if (typeof msg.txid === 'string') {
            ctx.trackedTxids.delete(msg.txid.toLowerCase());
          }
          break;
        case 'ping':
          send(ctx, { type: 'pong' });
          break;
        default:
          log.debug(`unknown action: ${(msg as { action: string }).action}`);
      }
    });

    socket.on('close', () => {
      clients.delete(ctx);
      log.debug(`client closed (total=${clients.size})`);
    });

    socket.on('error', err => {
      log.warn(`client error: ${err.message}`);
    });

    socket.on('pong', () => { ctx.aliveAt = Date.now(); });
  });

  const broadcast = (predicate: (c: ClientContext) => boolean, msg: WsServerMessage): void => {
    for (const client of clients) {
      if (predicate(client)) send(client, msg);
    }
  };

  app.on('mempool-update', (payload: MempoolUpdatePayload) => {
    broadcast(c => c.channels.has('mempool'), { type: 'mempool-update', data: payload });
  });

  app.on('block', (block: XmrBlockSummary) => {
    broadcast(c => c.channels.has('blocks'), { type: 'block', data: block });
  });

  app.on('fee-update', (payload: FeeUpdatePayload) => {
    broadcast(c => c.channels.has('fees'), { type: 'fee-update', data: payload });
  });

  app.on('tx-confirmed', payload => {
    for (const client of clients) {
      if (client.trackedTxids.has(payload.txid)) {
        send(client, {
          type: 'tx-confirmed',
          txid: payload.txid,
          block_height: payload.block_height,
          block_hash: payload.block_hash,
        });
      }
    }
  });

  // Heartbeat — detect stale connections
  const interval = setInterval(() => {
    const cutoff = Date.now() - 60_000;
    for (const client of clients) {
      if (client.socket.readyState !== WebSocket.OPEN) {
        clients.delete(client);
        continue;
      }
      if (client.aliveAt < cutoff) {
        try { client.socket.terminate(); } catch { /* noop */ }
        clients.delete(client);
        continue;
      }
      try { client.socket.ping(); } catch { /* noop */ }
    }
  }, 30_000);

  wss.on('close', () => {
    clearInterval(interval);
  });

  return wss;
};
