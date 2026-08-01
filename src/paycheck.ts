import { config } from "./config.js";
import type { KeeperHub } from "./keeperhub.js";
import { getPriceSignals } from "./signals.js";

export interface PayResult {
  paid: boolean;
  protocol?: string;
  executionId?: string;
  body: string;
  challenge?: string;
}

export async function payForRiskCheck(kh: KeeperHub, slug: string): Promise<PayResult> {
  let listing: Record<string, unknown> = {};
  try {
    listing = (await kh.getWorkflowListing(slug)) as Record<string, unknown>;
    console.log(`[Sentry] Listing "${slug}" price: ${String(listing.price ?? "?")} USD`);
  } catch (err) {
    console.warn(`[Sentry] Could not read listing for "${slug}" (${err instanceof Error ? err.message : err})`);
  }

  const signals = await getPriceSignals();
  const input = { userAddress: config.userAddress, drawdownPct: signals.drawdownPct, volatilityPct: signals.volatilityPct };

  console.log(`[Sentry] Calling paid workflow "${slug}" (x402/MPP)...`);
  const res = await kh.callWorkflowREST(slug, input);

  if (res.status === 200) {
    console.log(`[Sentry] Paid workflow returned:`);
    console.log(res.bodyText);
    return { paid: true, body: res.bodyText };
  }

  if (res.status === 402) {
    const challenge = res.headers.get("www-authenticate") ?? res.headers.get("payment-required") ?? "";
    console.log(`[Sentry] HTTP 402 — payment required`);
    console.log(`[Sentry] Challenge: ${challenge || res.bodyText}`);
    if (res.bodyText) console.log(`[Sentry] Body: ${res.bodyText}`);

    if (config.khWalletMcpUrl) {
      return payViaWallet(slug, input, challenge);
    }

    console.log(`[Sentry] To auto-pay, install @keeperhub/wallet and set KH_WALLET_MCP_URL, or settle the x402 challenge manually.`);
    return { paid: false, protocol: challenge.includes("x402") ? "x402" : "mpp", challenge, body: res.bodyText };
  }

  throw new Error(`Paid workflow call failed (${res.status}): ${res.bodyText}`);
}

async function payViaWallet(
  slug: string,
  input: Record<string, unknown>,
  challenge: string
): Promise<PayResult> {
  const { KeeperHub } = await import("./keeperhub.js");
  const wallet = new KeeperHub("", config.khWalletMcpUrl);
  try {
    const out = (await wallet.callTool("call_workflow", { slug, body: input, paymentHint: "auto" })) as Record<string, unknown>;
    console.log(`[Sentry] Agentic wallet auto-paid: protocol=${String(out.protocolUsed ?? "?")} paid=${String(out.paid)}`);
    console.log(`[Sentry] Workflow output: ${String(out.bodyText ?? "")}`);
    return {
      paid: Boolean(out.paid),
      protocol: String(out.protocolUsed ?? "?"),
      executionId: String(out.executionId ?? ""),
      body: String(out.bodyText ?? ""),
      challenge,
    };
  } catch (err) {
    console.error(`[Sentry] Wallet auto-pay failed (${err instanceof Error ? err.message : err})`);
    return { paid: false, challenge, body: `Wallet error: ${err instanceof Error ? err.message : err}` };
  }
}
