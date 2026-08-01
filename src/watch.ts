import { config } from "./config.js";
import { sentryDecide } from "./agent.js";
import { ruleDecision, type Decision } from "./decide.js";
import { KeeperHub } from "./keeperhub.js";
import { checkHealth, type HealthStatus } from "./monitor.js";
import { readPositionPublic } from "./publicread.js";
import { getPriceSignals, type PriceSignals } from "./signals.js";
import { banner, bold, cyan, dim, green, meter, red, reset, section, yellow } from "./ui.js";
import { short } from "./demo.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runWatch(addressArg?: string): Promise<void> {
  const address = (addressArg ?? config.userAddress ?? "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    console.error(`${red}✘${reset} Pass an Aave V3 address on Base: ${bold}npm run watch -- 0xYourAddress${reset}`);
    process.exit(1);
  }

  const kh = config.khApiKey ? new KeeperHub(config.khApiKey) : null;
  const via = kh ? "KeeperHub MCP" : "public RPC (demo mode)";
  let llmDecision: Decision | null = null;

  console.log("\x1Bc");
  while (true) {
    process.stdout.write("\x1Bc");
    banner();
    console.log(`  Watching ${cyan}${short(address)}${reset} on Base · via ${dim}${via}${reset} · refresh 5s · ${dim}Ctrl+C to stop${reset}\n`);

    let health: HealthStatus | undefined;
    let signals: PriceSignals = { priceUsd: 0, drawdownPct: 0, volatilityPct: 0 };

    try {
      health = kh ? await checkHealth(kh) : await readPositionPublic(address);
    } catch (err) {
      console.error(`  ${red}✘${reset} Read failed: ${err instanceof Error ? err.message : err}`);
      await sleep(5000);
      continue;
    }
    signals = await getPriceSignals().catch<PriceSignals>(() => ({ priceUsd: 0, drawdownPct: 0, volatilityPct: 0 }));

    if (health.hf > 0 && health.hf < config.hfThreshold && !llmDecision) {
      llmDecision = await sentryDecide(health, signals, false).catch(() => ruleDecision(health.hf, signals));
    }
    const decision = llmDecision ?? ruleDecision(health.hf, signals);

    section("Position health");
    const hfColor = health.hf <= config.hfHardFloor ? red : health.hf < config.hfThreshold ? yellow : green;
    console.log(`  Health factor   ${meter(health.hf, config.hfThreshold)}  ${hfColor}${bold}${health.hf.toFixed(3)}${reset}${dim}  (defend < ${config.hfThreshold})${reset}`);
    console.log(`  Collateral      $${health.totalCollateralBase.toFixed(2)}    Debt $${health.totalDebtBase.toFixed(2)}`);

    section("Market (last 5 min)");
    if (signals.priceUsd > 0) {
      console.log(`  ETH ${cyan}$${signals.priceUsd.toFixed(2)}${reset}  drawdown ${signals.drawdownPct.toFixed(2)}%  vol ${signals.volatilityPct.toFixed(2)}%`);
    } else {
      console.log(`  ${dim}price feed unreachable${reset}`);
    }

    section("Sentry verdict");
    const riskColor = decision.risk === "critical" ? red : decision.risk === "elevated" ? yellow : green;
    console.log(`  ${riskColor}${bold}${decision.action.toUpperCase()}${reset}  ${decision.amountUsdc ? `· ${decision.amountUsdc} USDC ` : ""}· ${Math.round(decision.confidence * 100)}% · ${dim}source: ${decision.source}${reset}`);
    for (const reason of decision.reasons) console.log(`    ${dim}•${reset} ${reason}`);

    const nextAction = decision.action === "hold"
      ? "standing by"
      : config.dryRun
        ? `would ${decision.action} ${decision.amountUsdc} USDC (dry-run)`
        : "defending on next breach";
    console.log(`\n  ${dim}status: ${nextAction} · ${new Date().toLocaleTimeString()}${reset}\n`);

    await sleep(5000);
  }
}
