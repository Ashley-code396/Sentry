import { config } from "./config.js";
import { KeeperHub } from "./keeperhub.js";
import { checkHealth, type HealthStatus } from "./monitor.js";
import { readPositionPublic } from "./publicread.js";
import { getPriceSignals } from "./signals.js";
import { short } from "./demo.js";
import { banner, cyan, dim, fail, meter, ok, reset, section, warn } from "./ui.js";

export async function runDoctor(addressArg?: string): Promise<void> {
  const address = (addressArg ?? config.userAddress ?? "").trim();
  const problems: string[] = [];

  banner();
  section("Preflight — Sentry");
  console.log(`  Node ${process.version} · Base (8453)`);

  section("1 · Environment");
  if (config.khApiKey) ok("KH_API_KEY set");
  else {
    fail("KH_API_KEY missing — run `npm run onboard` or copy .env.example → .env");
    problems.push("KH_API_KEY");
  }
  if (address) ok(`User address ${cyan}${short(address)}${reset}`);
  else {
    fail("No user address — set USER_ADDRESS in .env or pass one");
    problems.push("USER_ADDRESS");
  }
  if (config.openaiApiKey || config.anthropicApiKey) ok("LLM key set — full LangChain reasoning enabled");
  else warn("No LLM key — Sentry uses the rule-based decision (still fully functional)");

  section("2 · KeeperHub connectivity");
  if (config.khApiKey) {
    try {
      const kh = new KeeperHub(config.khApiKey);
      await kh.searchProtocolActions("aave");
      ok("MCP reachable, API key accepted");
    } catch (err) {
      fail(`Could not reach KeeperHub: ${err instanceof Error ? err.message : err}`);
      problems.push("KeeperHub connection");
    }
  } else {
    warn("Skipping connectivity check (no key)");
  }

  section("3 · Position read");
  if (address) {
    let health: HealthStatus | undefined;
    if (config.khApiKey) {
      try {
        health = await checkHealth(new KeeperHub(config.khApiKey));
        ok(`Read through KeeperHub — ${meter(health.hf, config.hfThreshold)}  HF ${health.hf.toFixed(3)}`);
      } catch (err) {
        warn(`KeeperHub read failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    if (!health) {
      try {
        health = await readPositionPublic(address);
        ok(`Read through public RPC (demo mode) — ${meter(health.hf, config.hfThreshold)}  HF ${health.hf.toFixed(3)}`);
      } catch (err) {
        fail(`Could not read position: ${err instanceof Error ? err.message : err}`);
        problems.push("Position read");
      }
    }
  }

  section("4 · Market data");
  try {
    const s = await getPriceSignals();
    ok(`Price feed OK — ETH $${s.priceUsd.toFixed(2)}, drawdown ${s.drawdownPct.toFixed(2)}%, vol ${s.volatilityPct.toFixed(2)}%`);
  } catch (err) {
    warn(`Price feed unreachable: ${err instanceof Error ? err.message : err}`);
  }

  section("Result");
  if (!problems.length) {
    ok("All checks passed — you're demo-ready.");
    console.log(`  ${dim}Next: npm run demo -- ${address || "0x…"}  ·  npm run loop  ·  npm run defend${reset}`);
  } else {
    for (const p of problems) warn(`Resolve: ${p}`);
    console.log(`  ${dim}Fix the items above, then re-run npm run doctor${reset}`);
  }
  console.log("");
}
