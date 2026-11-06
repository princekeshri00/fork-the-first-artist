/**
 * The steward's HTTP face. `/ask` is the only route the payments service needs.
 *
 * Note the trust boundary: this service answers because payments/ verified and
 * will settle. It does not itself take money — there is exactly one place that
 * settles x402 on this project, and it is payments/.
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createSteward, loadArtist } from './index.ts';
import { loadAgentConfig, providerAvailability } from './config.ts';
import { readBody, parseJson, sendJson, log } from './http.ts';
import type { OutputSchema } from './types.ts';

export interface StewardServerOptions {
  port?: number;
  forceFake?: boolean;
}

export async function startServer(opts: StewardServerOptions = {}): Promise<void> {
  const steward = await createSteward({ forceFake: opts.forceFake });
  const cfg = loadAgentConfig();
  const artist = await loadArtist();
  const port = opts.port ?? Number(process.env.PORT ?? 8403);

  const server = createServer((req, res) => {
    void (async () => {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
      res.setHeader('access-control-allow-headers', 'content-type,x-payment');
      if (req.method === 'OPTIONS') return void res.writeHead(204).end();

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      try {
        if (url.pathname === '/health') {
          return sendJson(res, 200, { ok: true, ...steward.describe(), uptimeSec: Math.round(process.uptime()) });
        }

        if (url.pathname === '/agent-card') {
          const providers = Object.entries(cfg.providers)
            .filter(([, p]) => p.kind === 'inference')
            .map(([id, p]) => {
              const avail = providerAvailability(p);
              return {
                id,
                label: p.label,
                model: p.defaultModel,
                transport: p.transport,
                capabilities: p.capabilities,
                usable: avail.usable,
                note: avail.reason,
                isDefault: id === cfg.default,
              };
            });
          return sendJson(res, 200, {
            artist: { name: artist.name, ensName: artist.ensName, bio: artist.bio, songs: artist.songs },
            agent: steward.describe(),
            providers,
            budget: cfg.budget,
            rail: cfg.rail,
          });
        }

        if (url.pathname === '/ask' && req.method === 'POST') {
          const body = parseJson(await readBody(req)) as
            | { instruction?: string; provider?: string; model?: string; tools?: string[]; json?: boolean }
            | undefined;
          if (!body?.instruction) {
            return sendJson(res, 400, { ok: false, error: { code: 'BAD_REQUEST', message: 'instruction required' } });
          }

          const output: OutputSchema<{ text: string }> | undefined = body.json
            ? {
                jsonSchema: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                  required: ['text'],
                  additionalProperties: false,
                },
                parse: (v) => {
                  const o = v as { text?: unknown };
                  if (typeof o?.text !== 'string') throw new Error('expected { text: string }');
                  return { text: o.text };
                },
              }
            : undefined;

          const result = await steward.run({
            instruction: body.instruction,
            provider: body.provider as never,
            model: body.model,
            tools: body.tools ?? ['get_artist_profile', 'get_songs', 'quote_tip'],
            output,
            context: { artist },
          });
          return sendJson(res, result.ok ? 200 : 422, result);
        }

        sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'try /health, /agent-card, POST /ask' } });
      } catch (err) {
        log.error('ask failed', { err: (err as Error).message });
        if (!res.headersSent) {
          sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: (err as Error).message } });
        }
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  const d = steward.describe();
  log.info('steward listening', {
    port,
    provider: d.provider,
    model: d.model,
    transport: d.transport,
    rail: d.rail,
    tools: d.tools.length,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await startServer();
}
