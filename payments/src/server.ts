/**
 * The payments service: one HTTP server, five routes.
 *
 *   POST /ask                          fan pays artist -> steward answers
 *   POST /meter/v1/chat/completions    agent pays per inference call (billed on 0G)
 *   GET  /meter/info                   price + budget + upstream, for the steward
 *   GET  /meter/v1/models              free model catalog passthrough
 *   GET  /.well-known/x402             machine-readable discovery (judges love this)
 *   GET  /ledger/recent                the HCS-backed spend log, tail
 *   GET  /split-preview?amount=0.10    96.31 / 3.69 arithmetic, for the UI
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadConfig, loadDotEnv, atomicToDecimal, type Config } from './config.ts';
import { createGate, type Gate } from './gate/index.ts';
import { SpendLog } from './spend-log.ts';
import { handleMeter, meterInfo, METER_PATH } from './meter.ts';
import { handleAsk, ASK_PATH } from './paywall.ts';
import { splitAtomic, describeSplit } from './split.ts';
import { readBody, parseJson, sendJson, log, type Ctx } from './http.ts';

export interface App {
  server: Server;
  cfg: Config;
  gate: Gate;
  spendLog: SpendLog;
}

export async function createApp(cfg: Config): Promise<App> {
  const gate = await createGate(cfg);
  const spendLog = new SpendLog(cfg);

  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-payment',
    'access-control-expose-headers': 'x-payment-response,x-payment-required',
  };

  const route = async (req: IncomingMessage): Promise<Ctx> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const raw = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
    return { req, res: null as never, url, raw, body: parseJson(raw) };
  };
  void route;

  const server = createServer((req, res) => {
    void (async () => {
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const started = Date.now();

      let ctx: Ctx;
      try {
        const raw = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
        ctx = { req, res, url, raw, body: parseJson(raw) };
      } catch (err) {
        sendJson(res, 400, { error: 'BAD_REQUEST', message: (err as Error).message });
        return;
      }

      try {
        switch (url.pathname) {
          case '/health':
            sendJson(res, 200, {
              ok: true,
              mode: cfg.mode,
              gate: gate.kind,
              network: cfg.network,
              asset: cfg.asset.id,
              split: cfg.split,
              uptimeSec: Math.round(process.uptime()),
            });
            return;

          case METER_PATH:
            if (req.method !== 'POST') {
              sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED', hint: 'POST here, GET /meter/info' });
              return;
            }
            await handleMeter(ctx, { cfg, gate, spendLog });
            return;

          case '/meter/info':
            sendJson(res, 200, { ...meterInfo(cfg), spent: await spendLog.totals() });
            return;

          case '/meter/v1/models':
            await handleModels(ctx, cfg);
            return;

          case ASK_PATH:
            if (req.method !== 'POST' && req.method !== 'GET') {
              sendJson(res, 405, { error: 'METHOD_NOT_ALLOWED' });
              return;
            }
            await handleAsk(ctx, { cfg, gate, spendLog });
            return;

          case '/ledger/recent':
            sendJson(res, 200, {
              entries: await spendLog.recent(Number(url.searchParams.get('n') ?? 20)),
              totals: await spendLog.totals(),
            });
            return;

          case '/split-preview': {
            const amount = url.searchParams.get('amount') ?? '0.10';
            const atomic = BigInt(Math.round(Number(amount) * 10 ** cfg.asset.decimals));
            const s = splitAtomic(atomic, cfg.split);
            sendJson(res, 200, {
              human: describeSplit(s, cfg.asset.decimals),
              totalAtomic: s.total.toString(),
              artistAtomic: s.artist.toString(),
              agentAtomic: s.agent.toString(),
              artistPct: cfg.split.artist / 100,
              agentPct: cfg.split.agent / 100,
            });
            return;
          }

          case '/.well-known/x402':
            sendJson(res, 200, discovery(cfg));
            return;

          default:
            sendJson(res, 404, {
              error: 'NOT_FOUND',
              endpoints: [ASK_PATH, METER_PATH, '/meter/info', '/ledger/recent', '/split-preview'],
            });
        }
      } catch (err) {
        log.error('unhandled', { path: url.pathname, err: (err as Error).message });
        if (!res.headersSent) {
          sendJson(res, 500, { error: 'INTERNAL', message: (err as Error).message });
        }
      } finally {
        log.info('request', {
          method: req.method,
          path: url.pathname,
          status: res.statusCode,
          ms: Date.now() - started,
        });
      }
    })();
  });

  void route;
  return { server, cfg, gate, spendLog };
}
async function handleModels(ctx: Ctx, cfg: Config): Promise<void> {
  if (cfg.mode === 'dev' && !cfg.upstream.apiKey) {
    sendJson(ctx.res, 200, {
      object: 'list',
      data: [
        { id: cfg.upstream.model, object: 'model', owned_by: '0g', devMock: true },
        { id: 'glm-5.2', object: 'model', owned_by: '0g', devMock: true },
      ],
    });
    return;
  }
  try {
    const res = await fetch(`${cfg.upstream.baseUrl}/models`, {
      headers: { authorization: `Bearer ${cfg.upstream.apiKey ?? ''}` },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    ctx.res.writeHead(res.status, { 'content-type': 'application/json' }).end(text);
  } catch (err) {
    sendJson(ctx.res, 502, { error: 'UPSTREAM_MODELS_FAILED', message: (err as Error).message });
  }
}

function discovery(cfg: Config): Record<string, unknown> {
  return {
    x402Version: 2,
    service: 'Open Source Orchestra — artist steward rails',
    network: cfg.network,
    asset: cfg.asset.id,
    split: { artist: cfg.split.artist / 100, agent: cfg.split.agent / 100 },
    resources: {
      [ASK_PATH]: {
        priceAtomic: cfg.prices.askAtomic.toString(),
        priceUsd: atomicToDecimal(cfg.prices.askAtomic, cfg.asset.decimals),
        payTo: cfg.accounts.artist || null,
        description: 'ask the artist steward a question',
      },
      [METER_PATH]: {
        priceAtomic: cfg.prices.meterAtomic.toString(),
        priceUsd: atomicToDecimal(cfg.prices.meterAtomic, cfg.asset.decimals),
        payTo: cfg.accounts.compute || null,
        description: `pay-per-call inference (${cfg.upstream.model})`,
      },
    },
    mode: cfg.mode,
  };
}

export async function start(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();
  const app = await createApp(cfg);
  app.server.listen(cfg.port, () => {
    log.info('payments listening', {
      port: cfg.port,
      mode: cfg.mode,
      gate: app.gate.kind,
      network: cfg.network,
      ask: `${atomicToDecimal(cfg.prices.askAtomic, cfg.asset.decimals)} USDC`,
      meter: `${atomicToDecimal(cfg.prices.meterAtomic, cfg.asset.decimals)} USDC`,
    });
  });
}

// run only when executed directly (`node src/server.ts`), not when imported by tests
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await start();
}
