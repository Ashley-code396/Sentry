import "dotenv/config";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  khApiKey: requireEnv("KH_API_KEY"),
  userAddress: requireEnv("USER_ADDRESS"),
  hfThreshold: parseFloat(process.env.HF_THRESHOLD ?? "1.25"),
  repayAmountUsdc: parseFloat(process.env.REPAY_AMOUNT_USDC ?? "5"),
  network: process.env.NETWORK ?? "8453",
  usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  dryRun: process.env.DRY_RUN === "true",
  hfHardFloor: parseFloat(process.env.HF_HARD_FLOOR ?? "1.05"),
  drawdownTriggerPct: parseFloat(process.env.DRAWDOWN_TRIGGER_PCT ?? "3"),
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  llmModel: process.env.LLM_MODEL ?? "",
  workflowSlug: process.env.WORKFLOW_SLUG ?? "sentry-risk-check",
  khWalletMcpUrl: process.env.KH_WALLET_MCP_URL ?? "",
  auditOutFile: process.env.AUDIT_OUT_FILE ?? "audit.md",
} as const;
