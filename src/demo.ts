import { config } from "./config.js";
import { sentryDecide } from "./agent.js";
import { KeeperHub } from "./keeperhub.js";
import { checkHealth, type HealthStatus } from "./monitor.js";
import { readPositionPublic } from "./publicread.js";
import { getPriceSignals } from "./signals.js";
import { banner, bold, cyan, dim, green, meter, ok, red, reset, section, warn, yellow } from "./ui.js";

export function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export async function runDemo(addressArg?: string): Promise<void> {
  const address = (addressArg ?? config.userAddress ?? "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    console.error(
      `${red}✘${reset} Pass an Aave V3 address on Base: ${bold}npm run demo -- 0xYourAddress${reset}\n` +
        `  (or set USER_ADDRESS in .env)`
    );
    process.exit(1);
  }

  banner();
  console.log(`  Monitoring Aave V3 position ${cyan}${short(address)}${reset} on Base (8453)\n`);

  let health: HealthStatus | undefined;
  let via = "";
  if (config.khApiKey) {
    try {
      health = await checkHealth(new KeeperHub(config.khApiKey));
      via = "KeeperHub MCP";
    } catch {
      // fall through to public read
    }
  }
  if (!health) {
    try {
      health = await readPositionPublic(address);
      via = "public RPC (demo mode)";
    } catch (err) {
      console.error(`${red}✘${reset} Could not read position: ${err instanceof Error ? err.message : err}`);
      console.error(`  Set KH_API_KEY in .env to read through KeeperHub, then retry.`);
      process.exit(1);
    }
  }

  const signals = await getPriceSignals().catch(() => ({ priceUsd: 0, drawdownPct: 0, volatilityPct: 0 }));
  const decision = await sentryDecide(health, signals, false);

  const hfLabel =
    health.hf <= config.hfHardFloor
      ? `${red}${health.hf.toFixed(3)}${reset}`
      : health.hf < config.hfThreshold
        ? `${yellow}${health.hf.toFixed(3)}${reset}`
        : `${green}${health.hf.toFixed(3)}${reset}`;

  section("Position health");
  console.log(`  ${bold}Health factor${reset}  ${meter(health.hf, config.hfThreshold)}  ${hfLabel}`);
  console.log(`  Collateral  $${health.totalCollateralBase.toFixed(2)}      Debt  $${health.totalDebtBase.toFixed(2)}`);
  console.log(`  Threshold   ${config.hfThreshold}   (defend below)   Hard floor ${config.hfHardFloor}`);

  section("Market signals (last 5 min)");
  if (signals.priceUsd > 0) {
    console.log(`  ETH  $${signals.priceUsd.toFixed(2)}   drawdown ${signals.drawdownPct.toFixed(2)}%   vol ${signals.volatilityPct.toFixed(2)}%`);
  } else {
    warn("Price feed unreachable — decision uses health factor only");
  }

  section("Sentry verdict");
  const riskColor = decision.risk === "critical" ? red : decision.risk === "elevated" ? yellow : green;
  console.log(`  ${bold}${riskColor}${decision.action.toUpperCase()}${reset}  ${decision.amountUsdc ? `(${decision.amountUsdc} USDC) ` : ""}confidence ${Math.round(decision.confidence * 100)}%`);
  for (const reason of decision.reasons) console.log(`    ${dim}•${reset} ${reason}`);

  console.log(`\n  ${dim}Read path: ${via} · decision source: ${decision.source}${reset}`);
  console.log(`  ${dim}Next: npm run onboard  → connect a wallet and defend through KeeperHub${reset}\n`);
}
