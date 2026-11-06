/**
 * Tiny node:http helpers — deliberately no framework. Two endpoints and a health
 * check do not justify a dependency tree, and every file the owner's agent has to
 * merge stays readable.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: unknown;
  raw: string;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export async function readBody(req: IncomingMessage, limitBytes = 256 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseJson(raw: string): unknown {
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** header lookup that is case-insensitive and returns undefined not '' */
export function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v || undefined;
}

export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export const log: Logger = {
  info: (msg, extra) => console.log(JSON.stringify({ level: 'info', msg, ...extra })),
  warn: (msg, extra) => console.warn(JSON.stringify({ level: 'warn', msg, ...extra })),
  error: (msg, extra) => console.error(JSON.stringify({ level: 'error', msg, ...extra })),
};
