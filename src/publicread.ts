import type { HealthStatus } from "./monitor.js";

const BASE_POOL = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const SELECTOR = "0xbf92857c";
const RPC = "https://mainnet.base.org";

const MAX_UINT256 = (1n << 256n) - 1n;

export async function readPositionPublic(address: string): Promise<HealthStatus> {
  const calldata = SELECTOR + address.toLowerCase().replace("0x", "").padStart(64, "0");

  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: BASE_POOL, data: calldata }, "latest"],
    }),
  });

  if (!res.ok) throw new Error(`Base RPC error (${res.status})`);
  const json = (await res.json()) as { error?: { message?: string }; result?: string };
  if (json.error) throw new Error(`Base RPC: ${json.error.message}`);

  const hex = json.result ?? "";
  if (hex.length !== 2 + 6 * 64) throw new Error("Unexpected getUserAccountData response length");

  const words: bigint[] = [];
  for (let i = 0; i < 6; i++) {
    words.push(BigInt("0x" + hex.slice(2 + i * 64, 2 + (i + 1) * 64)));
  }

  const hf = words[5] >= MAX_UINT256 ? 0 : Number(words[5]) / 1e18;
  return {
    hf,
    totalDebtBase: Number(words[1]) / 1e8,
    totalCollateralBase: Number(words[0]) / 1e8,
    raw: { via: "public RPC (demo mode)", pool: BASE_POOL, words: words.map(String) },
  };
}
