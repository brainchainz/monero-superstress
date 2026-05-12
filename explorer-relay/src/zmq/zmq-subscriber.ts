import { EventEmitter } from 'node:events';
import { Subscriber } from 'zeromq';
import { config } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('zmq');

const TOPICS = [
  'json-full-txpool_add',
  'json-full-chain_main',
  'json-minimal-txpool_add',
] as const;

type Topic = typeof TOPICS[number];

export interface ZmqTxPoolAddTx {
  id_hash: string;
  blob_size: number;
  weight?: number;
  fee: number;
  tx_json: string;
  kept_by_block?: boolean;
  receive_time?: number;
  relayed?: boolean;
  double_spend_seen?: boolean;
  do_not_relay?: boolean;
}

export interface ZmqChainMainBlock {
  major_version: number;
  minor_version: number;
  timestamp: number;
  prev_id: string;
  nonce: number;
  miner_tx: unknown;
  tx_hashes: string[];
  _height?: number;
  _hash?: string;
}

export interface ZmqMinimalTxPoolAdd {
  id: string;
  blob_size: number;
  weight?: number;
  fee: number;
}

export interface ZmqEvents {
  'new-tx':       (tx: ZmqTxPoolAddTx) => void;
  'new-block':    (data: { block: ZmqChainMainBlock; raw: unknown }) => void;
  'minimal-tx':   (data: ZmqMinimalTxPoolAdd[]) => void;
  'connected':    () => void;
  'disconnected': (reason: string) => void;
}

export declare interface ZmqSubscriber {
  on<K extends keyof ZmqEvents>(event: K, listener: ZmqEvents[K]): this;
  emit<K extends keyof ZmqEvents>(event: K, ...args: Parameters<ZmqEvents[K]>): boolean;
}

export class ZmqSubscriber extends EventEmitter {
  private sock: Subscriber | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly host: string = config.MONEROD_HOST,
    private readonly port: number = config.MONEROD_ZMQ_PORT,
  ) {
    super();
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.sock) {
      try { await this.sock.close(); } catch { /* noop */ }
      this.sock = null;
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    const sock = new Subscriber();
    this.sock = sock;
    const endpoint = `tcp://${this.host}:${this.port}`;

    try {
      sock.connect(endpoint);
      for (const topic of TOPICS) sock.subscribe(topic);
      log.info(`subscribed to ${endpoint} topics=${TOPICS.join(',')}`);
      this.emit('connected');
      this.recvLoop(sock).catch(err => {
        log.error(`recv loop died: ${(err as Error).message}`);
        this.scheduleReconnect('recv-loop-error');
      });
    } catch (err) {
      log.error(`connect failed: ${(err as Error).message}`);
      this.scheduleReconnect('connect-error');
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    this.emit('disconnected', reason);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      log.info('reconnecting...');
      void this.connect();
    }, 5_000);
  }

  private async recvLoop(sock: Subscriber): Promise<void> {
    for await (const frames of sock) {
      if (this.stopped) break;
      try {
        this.handleMessage(frames);
      } catch (err) {
        log.warn(`dispatch error: ${(err as Error).message}`);
      }
    }
  }

  private handleMessage(frames: Buffer[]): void {
    if (frames.length < 2) return;
    const topic = frames[0].toString('utf8') as Topic;
    const payload = frames[1].toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      log.warn(`non-JSON payload on ${topic}`);
      return;
    }

    switch (topic) {
      case 'json-full-txpool_add':
        this.handleTxPoolAdd(parsed);
        break;
      case 'json-full-chain_main':
        this.handleChainMain(parsed);
        break;
      case 'json-minimal-txpool_add':
        this.handleMinimalTxPoolAdd(parsed);
        break;
      default:
        log.debug(`unknown topic ${topic}`);
    }
  }

  private handleTxPoolAdd(parsed: unknown): void {
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of list) {
      if (item && typeof item === 'object') {
        this.emit('new-tx', item as ZmqTxPoolAddTx);
      }
    }
  }

  private handleChainMain(parsed: unknown): void {
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const raw of list) {
      if (raw && typeof raw === 'object') {
        this.emit('new-block', { block: raw as ZmqChainMainBlock, raw });
      }
    }
  }

  private handleMinimalTxPoolAdd(parsed: unknown): void {
    const list = Array.isArray(parsed) ? parsed : [parsed];
    const entries: ZmqMinimalTxPoolAdd[] = [];
    for (const item of list) {
      if (item && typeof item === 'object') entries.push(item as ZmqMinimalTxPoolAdd);
    }
    if (entries.length) this.emit('minimal-tx', entries);
  }
}
