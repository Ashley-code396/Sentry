import "dotenv/config";

function parsePositive(name: string, fallback: number): number {
  const value = parseFloat(process.env[name] ?? "");
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config = {
  khApiKey: process.env.KH_API_KEY ?? "",
  userAddress: process.env.USER_ADDRESS ?? "",
  hfThreshold: parsePositive("HF_THRESHOLD", 1.25),
  repayAmountUsdc: parsePositive("REPAY_AMOUNT_USDC", 5),
  network: process.env.NETWORK ?? "8453",
  usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  dryRun: process.env.DRY_RUN === "true",
  hfHardFloor: parsePositive("HF_HARD_FLOOR", 1.05),
  drawdownTriggerPct: parsePositive("DRAWDOWN_TRIGGER_PCT", 3),
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  llmModel: process.env.LLM_MODEL ?? "",
  workflowSlug: process.env.WORKFLOW_SLUG ?? "sentry-risk-check",
  khWalletMcpUrl: process.env.KH_WALLET_MCP_URL ?? "",
  auditOutFile: process.env.AUDIT_OUT_FILE ?? "audit.md",
} as const;

export function requireKh(): string {
  if (!config.khApiKey) {
    throw new Error("KH_API_KEY is not set. Run `npm run onboard` or copy .env.example to .env and add your kh_ key.");
  }
  return config.khApiKey;
}

export function requireUser(): string {
  if (!config.userAddress) {
    throw new Error("USER_ADDRESS is not set. Run `npm run onboard` or pass an address as an argument.");
  }
  return config.userAddress;
}
