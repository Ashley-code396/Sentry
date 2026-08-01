import { config } from "./config.js";
import type { KeeperHub } from "./keeperhub.js";

function repayNodeConfig(gasLimit?: number): Record<string, unknown> {
  return {
    actionType: "aave-v3/repay",
    network: config.network,
    asset: config.usdcAddress,
    amount: String(BigInt(Math.floor(config.repayAmountUsdc * 1e6))),
    interestRateMode: "2",
    onBehalfOf: config.userAddress,
    ...(gasLimit ? { gasLimit } : {}),
  };
}

export async function listRecentExecutions(kh: KeeperHub, limit = 10): Promise<Array<Record<string, unknown>>> {
  const raw = (await kh.restGet("/executions")) as Record<string, unknown> | unknown[];
  const rows = Array.isArray(raw) ? raw : Array.isArray((raw as Json).executions) ? ((raw as Json).executions as unknown[]) : [];
  return rows.slice(0, limit).map((r) => r as Record<string, unknown>);
}

type Json = Record<string, unknown>;

export async function stageFailure(kh: KeeperHub): Promise<string> {
  console.log(`[Sentry] Staging a reliability failure: low-gas repay workflow (gasLimit=50000)...`);

  try {
    const created = (await kh.createWorkflow({
      name: "Sentry Failure Demo",
      description: "Deliberately under-funded gas repay to exercise KeeperHub simulation + retry.",
      nodes: [
        { id: "trigger", type: "trigger", data: { label: "Manual Trigger", config: { triggerType: "Manual" } } },
        {
          id: "repay-low-gas",
          type: "action",
          data: { label: "Repay Low Gas", config: repayNodeConfig(50000) },
        },
      ],
      edges: [{ id: "e1", source: "trigger", target: "repay-low-gas" }],
    })) as Json;

    const workflowId = String(created.workflowId ?? created.id ?? "");
    if (!workflowId) throw new Error(`create_workflow returned no workflowId: ${JSON.stringify(created)}`);

    console.log(`[Sentry] Low-gas workflow created: ${workflowId}`);
    const run = (await kh.executeWorkflow(workflowId, {})) as Json;
    const executionId = String(run.executionId ?? run.id ?? "");
    console.log(`[Sentry] Execution started: ${executionId}`);
    console.log(`[Sentry] Next: npm run audit -- ${executionId}  (expect a failed/simulated run or retry trail)`);
    return executionId;
  } catch (err) {
    console.error(`[Sentry] Low-gas workflow not supported: ${err instanceof Error ? err.message : err}`);
    console.error(`[Sentry] Fallback: run npm run defend, then npm run executions, then audit a run from a congestion window.`);
    throw err;
  }
}
