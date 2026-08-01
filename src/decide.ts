import { config } from "./config.js";
import type { PriceSignals } from "./signals.js";

export type Risk = "low" | "elevated" | "critical";
export type Action = "hold" | "topup" | "repay" | "close";

export interface Decision {
  risk: Risk;
  action: Action;
  amountUsdc: number;
  reasons: string[];
  confidence: number;
  source: "rule" | "llm";
  steps?: Array<{ name: string; args: string; result: string }>;
}

export function ruleDecision(hf: number, signals: PriceSignals): Decision {
  const { drawdownPct, volatilityPct } = signals;

  if (hf > 0 && hf <= config.hfHardFloor) {
    return {
      risk: "critical",
      action: "repay",
      amountUsdc: 10,
      confidence: 0.95,
      source: "rule",
      reasons: [
        `HF ${hf.toFixed(4)} is at the hard floor (${config.hfHardFloor}) — liquidation imminent`,
        `Repaying 10 USDC immediately to push HF back above the floor`,
      ],
    };
  }

  if (hf > 0 && hf < config.hfThreshold) {
    if (drawdownPct >= config.drawdownTriggerPct) {
      return {
        risk: "elevated",
        action: "repay",
        amountUsdc: config.repayAmountUsdc,
        confidence: 0.85,
        source: "rule",
        reasons: [
          `HF ${hf.toFixed(4)} below threshold ${config.hfThreshold}`,
          `ETH ${drawdownPct.toFixed(2)}% drawdown in the last 5 min (${volatilityPct.toFixed(2)}% vol) — cascade risk is real`,
          `Partial repay of ${config.repayAmountUsdc} USDC lowers liquidation risk`,
        ],
      };
    }
    return {
      risk: "low",
      action: "hold",
      amountUsdc: 0,
      confidence: 0.6,
      source: "rule",
      reasons: [
        `HF ${hf.toFixed(4)} below threshold ${config.hfThreshold} but drawdown is only ${drawdownPct.toFixed(2)}%`,
        `Movement looks like noise, not a cascade — holding to avoid burning gas`,
      ],
    };
  }

  return {
    risk: "low",
    action: "hold",
    amountUsdc: 0,
    confidence: 0.9,
    source: "rule",
    reasons: [`HF ${hf.toFixed(4)} is healthy (>= ${config.hfThreshold})`],
  };
}
