import { config } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
const current = LEVELS[config.LOG_LEVEL] ?? LEVELS.info;

const ts = (): string => new Date().toISOString();

const emit = (level: keyof typeof LEVELS, scope: string, msg: string, extra?: unknown): void => {
  if (LEVELS[level] < current) return;
  const line = `[${ts()}] ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  if (extra !== undefined) {
    const target = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    target(line, extra);
  } else {
    const target = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    target(line);
  }
};

export const createLogger = (scope: string) => ({
  debug: (msg: string, extra?: unknown) => emit('debug', scope, msg, extra),
  info:  (msg: string, extra?: unknown) => emit('info', scope, msg, extra),
  warn:  (msg: string, extra?: unknown) => emit('warn', scope, msg, extra),
  error: (msg: string, extra?: unknown) => emit('error', scope, msg, extra),
});

export type Logger = ReturnType<typeof createLogger>;
