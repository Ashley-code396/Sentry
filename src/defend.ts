import { config } from "./config.js";
import { KeeperHub } from "./keeperhub.js";

export interface RepayResult {
  transactionHash: string;
  transactionLink: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function partialRepay(kh: KeeperHub, amountUsdcOverride?: number): Promise<RepayResult> {
  const amountUsdc = amountUsdcOverride ?? config.repayAmountUsdc;
  const amountWei = BigInt(Math.floor(amountUsdc * 1e6)).toString();

  const result = (await kh.executeProtocolAction({
    actionType: "aave-v3/repay",
    network: config.network,
    asset: config.usdcAddress,
    amount: amountWei,
    interestRateMode: "2",
    onBehalfOf: config.userAddress,
  })) as Record<string, unknown>;

  if (result.transactionHash) {
    return {
      transactionHash: String(result.transactionHash),
      transactionLink: String(result.transactionLink ?? `https://basescan.org/tx/${result.transactionHash}`),
    };
  }

  const executionId = String(result.executionId ?? result.id ?? "");
  if (!executionId) throw new Error("No execution ID returned from repay action");

  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const status = (await kh.getDirectExecutionStatus(executionId)) as Record<string, unknown>;
    if (status.transactionHash) {
      return {
        transactionHash: String(status.transactionHash),
        transactionLink: String(status.transactionLink ?? `https://basescan.org/tx/${status.transactionHash}`),
      };
    }
    if (status.status === "failed" || status.error) {
      throw new Error(String(status.error ?? "Repay execution failed"));
    }
  }

  throw new Error("Timed out waiting for repay transaction");
}
