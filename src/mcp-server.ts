import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config, requireKh } from "./config.js";
import { KeeperHub } from "./keeperhub.js";
import { checkHealth, type HealthStatus } from "./monitor.js";
import { readPositionPublic } from "./publicread.js";
import { getPriceSignals, type PriceSignals } from "./signals.js";
import { ruleDecision } from "./decide.js";
import { partialRepay } from "./defend.js";
import { listRecentExecutions } from "./failure.js";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

function kh(): KeeperHub {
  return new KeeperHub(requireKh());
}

async function statusFor(user: string): Promise<{ health: HealthStatus; signals: PriceSignals; decision: ReturnType<typeof ruleDecision>; readPath: string }> {
  let health: HealthStatus;
  let readPath: string;
  if (config.khApiKey) {
    health = await checkHealth(kh());
    readPath = "KeeperHub MCP";
  } else {
    health = await readPositionPublic(user);
    readPath = "public RPC (demo mode)";
  }
  const signals = await getPriceSignals().catch<PriceSignals>(() => ({ priceUsd: 0, drawdownPct: 0, volatilityPct: 0 }));
  return { health, signals, decision: ruleDecision(health.hf, signals), readPath };
}

const server = new McpServer({ name: "sentry", version: "0.1.0" });

server.tool(
  "sentry_status",
  "Evaluate an Aave V3 position on Base: health factor, collateral, debt, 5-minute market signals, and a defensive verdict.",
  { user: z.string().describe("Aave V3 user address on Base") },
  async ({ user }) => {
    const { health, signals, decision, readPath } = await statusFor(user);
    return text({ user, readPath, health, signals, decision });
  }
);

server.tool(
  "get_aave_account_data",
  "Read raw Aave V3 account data for a user on Base (health factor, debt, collateral).",
  { user: z.string().describe("Aave V3 user address on Base") },
  async ({ user }) => {
    if (!config.khApiKey) {
      const health = await readPositionPublic(user);
      return text(health);
    }
    return text(
      await kh().executeProtocolAction({
        actionType: "aave-v3/get-user-account-data",
        network: config.network,
        user,
      })
    );
  }
);

server.tool(
  "get_price_signal",
  "Fetch 5-minute ETH/USDC candles: current price, drawdown % from the 5-min peak, realized volatility %.",
  {},
  async () => text(await getPriceSignals())
);

server.tool(
  "execute_protocol_action",
  "THE ONLY onchain execution path. Execute a KeeperHub protocol action (e.g. aave-v3/repay). Blocked when DRY_RUN=true.",
  {
    actionType: z.string().describe("e.g. aave-v3/repay"),
    asset: z.string().optional(),
    amount: z.string().optional().describe("amount in wei"),
    interestRateMode: z.string().optional().describe("2 = variable"),
  },
  async ({ actionType, asset, amount, interestRateMode }) => {
    if (config.dryRun) {
      return text({ blocked: "DRY-RUN", note: `Would execute ${actionType} asset=${asset ?? "n/a"} amount=${amount ?? "n/a"}` });
    }
    const result = await kh().executeProtocolAction({
      actionType,
      network: config.network,
      asset,
      amount,
      interestRateMode: interestRateMode ?? "2",
      onBehalfOf: config.userAddress,
    });
    return text(result);
  }
);

server.tool(
  "defend",
  "Trigger a defensive partial USDC repay on the configured position through KeeperHub.",
  { amountUsdc: z.number().optional().describe("USDC amount to repay (default from config)") },
  async ({ amountUsdc }) => {
    if (config.dryRun) {
      return text({ blocked: "DRY-RUN", note: "Set DRY_RUN=false in .env to allow execution." });
    }
    return text(await partialRepay(kh(), amountUsdc));
  }
);

server.tool(
  "list_executions",
  "List recent KeeperHub executions with status, timestamps and transaction hashes.",
  {},
  async () => text(await listRecentExecutions(kh(), 20))
);

server.tool(
  "get_execution",
  "Fetch the audit trail of a KeeperHub execution: per-step logs, gas usage, tx hashes.",
  { executionId: z.string() },
  async ({ executionId }) => text(await kh().getExecution(executionId))
);

const transport = new StdioServerTransport();
await server.connect(transport);
