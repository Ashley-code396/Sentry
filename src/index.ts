import { config, requireKh } from "./config.js";
import { sentryDecide } from "./agent.js";
import type { Decision } from "./decide.js";
import { partialRepay } from "./defend.js";
import { auditToFile, renderAudit } from "./audit.js";
import { listRecentExecutions, stageFailure } from "./failure.js";
import { KeeperHub } from "./keeperhub.js";
import { checkHealth } from "./monitor.js";
import { payForRiskCheck } from "./paycheck.js";
import { publishRiskCheck } from "./publish.js";
import { getPriceSignals } from "./signals.js";
import { runDemo } from "./demo.js";
import { runDoctor } from "./doctor.js";
import { runOnboard } from "./onboard.js";
import { runWatch } from "./watch.js";

const cmd = process.argv[2];
const arg = process.argv[3];

function getKh(): KeeperHub {
  return new KeeperHub(requireKh());
}

async function runCheck(): Promise<void> {
  const status = await checkHealth(getKh());
  console.log(JSON.stringify({ ...status, threshold: config.hfThreshold }, null, 2));
}

async function runDecide(): Promise<void> {
  const status = await checkHealth(getKh());
  const signals = await getPriceSignals();
  const decision = await sentryDecide(status, signals, false);
  console.log(
    JSON.stringify(
      {
        hf: status.hf,
        debtUsd: status.totalDebtBase,
        collateralUsd: status.totalCollateralBase,
        signals,
        decision,
      },
      null,
      2
    )
  );
}

async function runDefend(): Promise<void> {
  console.log(`[Sentry] Forcing partial repay of ${config.repayAmountUsdc} USDC...`);
  const result = await partialRepay(getKh());
  console.log(`[Sentry] Repay confirmed: ${result.transactionLink}`);
}

async function runPublish(): Promise<void> {
  const { slug, workflowId } = await publishRiskCheck(getKh());
  console.log(`[Sentry] Published paid risk-check "${slug}" (workflow ${workflowId})`);
}

async function runPaycheck(): Promise<void> {
  const result = await payForRiskCheck(getKh(), config.workflowSlug);
  if (!result.paid) {
    console.log(`[Sentry] Payment required but not settled. Challenge captured; install @keeperhub/wallet to auto-pay.`);
    process.exitCode = 2;
  }
}

async function runExecutions(): Promise<void> {
  const rows = await listRecentExecutions(getKh());
  if (!rows.length) {
    console.log(`[Sentry] No executions found.`);
    return;
  }
  for (const row of rows) {
    const hashes = Array.isArray(row.transactionHashes) ? row.transactionHashes.join(",") : "";
    console.log(
      `${String(row.id)}  ${String(row.status ?? "?").padEnd(9)}  ${String(row.startedAt ?? "")}  ${String(row.workflowId ?? "")}  ${hashes}`
    );
  }
}

async function runAudit(executionId: string): Promise<void> {
  const { markdown } = await renderAudit(getKh(), executionId);
  console.log(markdown);
  await auditToFile(getKh(), executionId, config.auditOutFile);
}

async function runStageFailure(): Promise<void> {
  await stageFailure(getKh());
}

function findExecutedTx(steps: Decision["steps"]): string | null {
  for (const step of steps ?? []) {
    try {
      const out = JSON.parse(step.result) as Record<string, unknown>;
      if (out.transactionLink) return String(out.transactionLink);
      if (out.transactionHash) return `https://basescan.org/tx/${out.transactionHash}`;
    } catch {
      // step result was not JSON — keep scanning
    }
  }
  return null;
}

async function runLoop(): Promise<void> {
  console.log(`[Sentry] Monitoring HF every 60s (threshold: ${config.hfThreshold}, dry-run: ${config.dryRun})`);
  let acted = false;
  const kh = getKh();

  while (true) {
    const status = await checkHealth(kh);
    const signals = await getPriceSignals();
    console.log(
      `[Sentry] HF=${status.hf.toFixed(4)} debt=$${status.totalDebtBase.toFixed(2)} collateral=$${status.totalCollateralBase.toFixed(2)} ETH=$${signals.priceUsd.toFixed(2)} drawdown=${signals.drawdownPct.toFixed(2)}%`
    );

    if (!acted && status.hf < config.hfThreshold && status.hf > 0) {
      const decision = await sentryDecide(status, signals, !config.dryRun);
      console.log(`[Sentry] decision=${decision.action} risk=${decision.risk} confidence=${decision.confidence}`);
      for (const reason of decision.reasons) console.log(`[Sentry]   - ${reason}`);

      if (decision.action !== "hold") {
        const txLink = findExecutedTx(decision.steps);
        if (txLink) {
          console.log(`[Sentry] Executed via KeeperHub: ${txLink}`);
          acted = true;
        } else if (config.dryRun) {
          console.log(`[Sentry] DRY-RUN: would ${decision.action} ${decision.amountUsdc} USDC`);
          acted = true;
        } else {
          const result = await partialRepay(kh);
          console.log(`[Sentry] Defended: ${result.transactionLink}`);
          acted = true;
        }
      }
    }

    await new Promise((r) => setTimeout(r, 60_000));
  }
}

const commands: Record<string, () => Promise<void>> = {
  doctor: () => runDoctor(arg),
  demo: () => runDemo(arg),
  watch: () => runWatch(arg),
  onboard: runOnboard,
  check: runCheck,
  decide: runDecide,
  defend: runDefend,
  publish: runPublish,
  paycheck: runPaycheck,
  executions: runExecutions,
  "stage-failure": runStageFailure,
  audit: () => {
    if (!arg) {
      console.error("Usage: npm run audit -- <executionId>");
      process.exit(1);
    }
    return runAudit(arg);
  },
  loop: runLoop,
};

if (!cmd || !commands[cmd]) {
  console.error(
    "Usage: npm run <onboard|doctor|demo|watch|check|decide|defend|publish|paycheck|executions|audit|stage-failure|loop>"
  );
  process.exit(1);
}

commands[cmd]().catch((err) => {
  console.error(`[Sentry] Error:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
