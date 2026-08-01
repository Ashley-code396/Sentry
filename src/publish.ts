import { config } from "./config.js";
import type { KeeperHub } from "./keeperhub.js";

const DECISION_SCRIPT = `const hf = Number("{{@get-account:Get User Account Data.healthFactor}}") / 1e18;
const debt = Number("{{@get-account:Get User Account Data.totalDebtBase}}") / 1e8;
const collateral = Number("{{@get-account:Get User Account Data.totalCollateralBase}}") / 1e8;
const drawdownPct = Number("{{@trigger:Manual Trigger.drawdownPct}}");
const volatilityPct = Number("{{@trigger:Manual Trigger.volatilityPct}}");
const threshold = 1.25;
const hardFloor = 1.05;
let risk, action, amountUsdc, reasons;
if (hf > 0 && hf <= hardFloor) {
  risk = "critical"; action = "repay"; amountUsdc = 10;
  reasons = ["HF at hard floor — liquidation imminent", "Repaying 10 USDC immediately"];
} else if (hf > 0 && hf < threshold) {
  if (drawdownPct >= 3) {
    risk = "elevated"; action = "repay"; amountUsdc = 5;
    reasons = ["HF below threshold", "drawdown >= 3% — cascade risk is real", "Partial repay lowers liquidation risk"];
  } else {
    risk = "low"; action = "hold"; amountUsdc = 0;
    reasons = ["HF below threshold but drawdown too small — noise", "Holding to avoid burning gas"];
  }
} else {
  risk = "low"; action = "hold"; amountUsdc = 0;
  reasons = ["HF healthy"];
}
return JSON.stringify({ userAddress: "{{@trigger:Manual Trigger.userAddress}}", hf, debt, collateral, drawdownPct, volatilityPct, risk, action, amountUsdc, reasons });`;

async function discoverCodeAction(kh: KeeperHub): Promise<string> {
  try {
    const schemas = (await kh.restGet("/mcp/schemas")) as { actions?: Record<string, { actionType?: string; integration?: string; label?: string }> };
    for (const entry of Object.values(schemas.actions ?? {})) {
      if (entry.integration === "code" || (entry.actionType ?? "").startsWith("code/")) return entry.actionType!;
    }
  } catch {
    // schemas endpoint unavailable — fall back to default
  }
  return "code/run-code";
}

export interface PublishedWorkflow {
  workflowId: string;
  slug: string;
  listing: unknown;
}

export async function publishRiskCheck(kh: KeeperHub): Promise<PublishedWorkflow> {
  const codeAction = await discoverCodeAction(kh);
  console.log(`[Sentry] Using code action: ${codeAction}`);

  const workflow = {
    name: "Sentry Risk Check",
    description: "Evaluate an Aave V3 position health factor against off-chain price signals.",
    nodes: [
      {
        id: "trigger",
        type: "trigger",
        data: { label: "Manual Trigger", config: { triggerType: "Manual" } },
      },
      {
        id: "get-account",
        type: "action",
        data: {
          label: "Get User Account Data",
          config: {
            actionType: "aave-v3/get-user-account-data",
            network: config.network,
            user: "{{@trigger:Manual Trigger.userAddress}}",
          },
        },
      },
      {
        id: "decide",
        type: "action",
        data: {
          label: "Run Decision",
          config: { actionType: codeAction, script: DECISION_SCRIPT },
        },
      },
    ],
    edges: [
      { id: "e1", source: "trigger", target: "get-account" },
      { id: "e2", source: "get-account", target: "decide" },
    ],
  };

  const created = (await kh.createWorkflow(workflow)) as Record<string, unknown>;
  const workflowId = String(created.workflowId ?? created.id ?? "");
  if (!workflowId) throw new Error(`create_workflow returned no workflowId: ${JSON.stringify(created)}`);
  console.log(`[Sentry] Workflow created: ${workflowId}`);

  const listing = await kh.listWorkflow({
    workflowId,
    slug: config.workflowSlug,
    name: "Sentry Risk Check",
    description: "Pay-per-check Aave V3 position risk evaluation. Returns HF, risk, action and reasons.",
    price: "0.01",
    category: "DeFi Risk",
    tags: ["risk", "aave", "health-factor"],
    chain: config.network,
    inputSchema: {
      type: "object",
      properties: {
        userAddress: { type: "string", description: "Aave V3 user address to evaluate" },
        drawdownPct: { type: "number", description: "5-min collateral drawdown %" },
        volatilityPct: { type: "number", description: "5-min realized volatility %" },
      },
      required: ["userAddress"],
    },
  });

  console.log(`[Sentry] Listed as paid workflow "$ ${config.workflowSlug}" ($0.01/call)`);
  console.log(`[Sentry]   MCP (per-workflow server): https://app.keeperhub.com/mcp/w/${config.workflowSlug}`);
  console.log(`[Sentry]   REST (x402/MPP):           https://app.keeperhub.com/api/mcp/workflows/${config.workflowSlug}/call`);

  return { workflowId, slug: config.workflowSlug, listing };
}
