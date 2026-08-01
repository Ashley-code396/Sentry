import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config, requireKh } from "../config.js";
import { KeeperHub } from "../keeperhub.js";
import { checkHealth, type HealthStatus } from "../monitor.js";
import { readPositionPublic } from "../publicread.js";
import { getPriceSignals, type PriceSignals } from "../signals.js";
import { ruleDecision } from "../decide.js";
import { partialRepay } from "../defend.js";
import { listRecentExecutions } from "../failure.js";
import { renderAudit } from "../audit.js";
import { chatWithSentry } from "../chat.js";

const staticDir = join(dirname(fileURLToPath(import.meta.url)), "static");

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

interface StatusContext {
  health: HealthStatus;
  signals: PriceSignals;
  address: string;
  readPath: string;
}

async function getStatus(address: string): Promise<StatusContext> {
  let health: HealthStatus;
  let readPath: string;
  if (config.khApiKey) {
    health = await checkHealth(new KeeperHub(config.khApiKey));
    readPath = "KeeperHub MCP";
  } else {
    health = await readPositionPublic(address);
    readPath = "public RPC (demo mode)";
  }
  const signals = await getPriceSignals().catch<PriceSignals>(() => ({ priceUsd: 0, drawdownPct: 0, volatilityPct: 0 }));
  return { health, signals, address, readPath };
}

function resolveAddress(query: URLSearchParams): string {
  const q = (query.get("addr") ?? "").trim();
  return q || config.userAddress;
}

export function createWebServer(): Server {
  const html = readFileSync(join(staticDir, "index.html"), "utf8");

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "GET" && (path === "/" || path === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }

      if (req.method === "GET" && path === "/api/status") {
        const address = resolveAddress(url.searchParams);
        if (!address) {
          json(res, 400, { error: "No address. Set USER_ADDRESS in .env or pass ?addr=0x…" });
          return;
        }
        const { health, signals, address: a, readPath } = await getStatus(address);
        const decision = ruleDecision(health.hf, signals);
        json(res, 200, {
          address: a,
          readPath,
          dryRun: config.dryRun,
          threshold: config.hfThreshold,
          health,
          signals,
          decision: { ...decision, source: decision.source },
        });
        return;
      }

      if (req.method === "POST" && path === "/api/chat") {
        const body = await readBody(req);
        const message = String(body.message ?? "").trim();
        if (!message) {
          json(res, 400, { error: "message is required" });
          return;
        }
        const result = await chatWithSentry(message);
        json(res, 200, result);
        return;
      }

      if (req.method === "GET" && path === "/api/executions") {
        const rows = config.khApiKey ? await listRecentExecutions(new KeeperHub(config.khApiKey), 20) : [];
        json(res, 200, rows);
        return;
      }

      const auditMatch = path.match(/^\/api\/audit\/([^/]+)$/);
      if (req.method === "GET" && auditMatch) {
        const { markdown } = await renderAudit(new KeeperHub(requireKh()), auditMatch[1]);
        json(res, 200, { executionId: auditMatch[1], markdown });
        return;
      }

      if (req.method === "POST" && path === "/api/defend") {
        if (config.dryRun) {
          json(res, 403, { error: "DRY_RUN is on — set DRY_RUN=false in .env to execute." });
          return;
        }
        const result = await partialRepay(new KeeperHub(requireKh()));
        json(res, 200, result);
        return;
      }

      json(res, 404, { error: "not found" });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
}

export async function runWebServer(port = parseInt(process.env.PORT ?? "4321", 10)): Promise<void> {
  const server = createWebServer();

  server.listen(port, () => {
    console.log(`\n  Sentry dashboard → http://localhost:${port}\n`);
    console.log(`  Add ?addr=0x… to watch a specific position (or set USER_ADDRESS).`);
    console.log(`  Dry-run: ${config.dryRun ? "ON (no onchain execution)" : "off"}\n`);
  });
}
