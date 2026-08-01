import { config } from "./config.js";
import { KeeperHub } from "./keeperhub.js";

export interface HealthStatus {
  hf: number;
  totalDebtBase: number;
  totalCollateralBase: number;
  raw: Record<string, unknown>;
}

export async function checkHealth(kh: KeeperHub): Promise<HealthStatus> {
  const raw = (await kh.executeProtocolAction({
    actionType: "aave-v3/get-user-account-data",
    network: config.network,
    user: config.userAddress,
  })) as Record<string, unknown>;

  const hf = Number(raw.healthFactor ?? 0) / 1e18;
  const totalDebtBase = Number(raw.totalDebtBase ?? 0) / 1e8;
  const totalCollateralBase = Number(raw.totalCollateralBase ?? 0) / 1e8;

  return { hf, totalDebtBase, totalCollateralBase, raw };
}
