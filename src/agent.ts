import { DynamicStructuredTool } from "@langchain/core/tools";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { config } from "./config.js";
import { KeeperHub } from "./keeperhub.js";
import type { HealthStatus } from "./monitor.js";
import { getPriceSignals, type PriceSignals } from "./signals.js";
import { ruleDecision, type Decision } from "./decide.js";

const kh = new KeeperHub(config.khApiKey);

const SYSTEM_PROMPT = `You are Sentry, an autonomous position-risk agent for an Aave V3 position on Base.

You receive a health snapshot (health factor, debt, collateral) and price signals (5-minute drawdown, volatility). Your job is to decide the single best defensive action and explain it.

Decision rules:
- HF >= threshold: HOLD. Position is healthy.
- HF < threshold AND drawdown >= 3%: REPAY a partial USDC amount. This is real risk, not noise — a falling collateral price with a low health factor is a cascade.
- HF < threshold but drawdown is small: HOLD. Likely oracle noise; acting would burn gas for nothing.
- HF <= 1.05 (hard floor): REPAY 10 USDC immediately — liquidation is imminent.

You may call get_aave_account_data or get_price_signal to verify the snapshot before deciding. Only call execute_protocol_action when you have decided to act AND dryRun is false — it is the ONLY onchain execution path and it must go through KeeperHub.

Respond with ONLY a JSON object, no prose:
{"risk":"low|elevated|critical","action":"hold|topup|repay|close","amountUsdc":<number>,"reasons":["...","..."],"confidence":<0..1>}`;

type MsgLike = {
  _getType(): string;
  name?: string;
  tool_calls?: Array<{ name: string; args: unknown }>;
  content: string | Array<{ text?: string }>;
};

const msgText = (m: MsgLike): string =>
  typeof m.content === "string" ? m.content : m.content.map((b) => b.text ?? "").join("");

function buildLlm() {
  const model = config.llmModel;
  if (config.anthropicApiKey) {
    return new ChatAnthropic({ model: model || "claude-sonnet-4-5", temperature: 0 });
  }
  if (config.openaiApiKey) {
    return new ChatOpenAI({ model: model || "gpt-4o-mini", temperature: 0 });
  }
  return null;
}

function makeTools(allowExecute: boolean) {
  return [
    new DynamicStructuredTool({
      name: "get_aave_account_data",
      description:
        "Read the Aave V3 position of the monitored user: health factor, total debt (USD), total collateral (USD). Returns a JSON object.",
      schema: z.object({}),
      func: async () =>
        JSON.stringify(
          await kh.executeProtocolAction({
            actionType: "aave-v3/get-user-account-data",
            network: config.network,
            user: config.userAddress,
          })
        ),
    }),
    new DynamicStructuredTool({
      name: "get_price_signal",
      description:
        "Fetch 5-minute ETH/USDC candles. Returns current price (USD), drawdown % (fall from the 5-min peak) and realized volatility %.",
      schema: z.object({}),
      func: async () => JSON.stringify(await getPriceSignals()),
    }),
    new DynamicStructuredTool({
      name: "execute_protocol_action",
      description:
        "THE ONLY onchain execution path. Execute a KeeperHub protocol action. Supported: aave-v3/repay (partial USDC debt repay: asset, amount in wei, interestRateMode 2, onBehalfOf). Returns the execution result with transactionHash/link.",
      schema: z.object({
        actionType: z.string(),
        asset: z.string().optional(),
        amount: z.string().optional(),
        interestRateMode: z.string().optional(),
      }),
      func: async ({ actionType, asset, amount, interestRateMode }) => {
        if (!allowExecute || config.dryRun) {
          return `DRY-RUN: onchain execution blocked. Would execute ${actionType} asset=${asset ?? "n/a"} amount=${amount ?? "n/a"}. State the decision only.`;
        }
        return JSON.stringify(
          await kh.executeProtocolAction({
            actionType,
            network: config.network,
            asset,
            amount,
            interestRateMode: interestRateMode ?? "2",
            onBehalfOf: config.userAddress,
          })
        );
      },
    }),
  ];
}

function collectSteps(messages: MsgLike[]): Decision["steps"] {
  const steps: NonNullable<Decision["steps"]> = [];
  for (const m of messages) {
    for (const call of m.tool_calls ?? []) {
      steps.push({ name: call.name, args: JSON.stringify(call.args), result: "" });
    }
    if (m._getType() === "tool" && m.name) {
      const last = steps.map((s, i) => ({ s, i })).filter(({ s }) => s.name === m.name && s.result === "").pop();
      if (last) last.s.result = msgText(m);
    }
  }
  return steps;
}

function parseDecisionJson(text: string): Partial<Decision> {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed) as Partial<Decision>;
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = fenced ? fenced[1] : trimmed.match(/\{[\s\S]*\}/)?.[0];
    if (body) {
      try {
        return JSON.parse(body) as Partial<Decision>;
      } catch {
        return {};
      }
    }
    return {};
  }
}

export async function sentryDecide(
  snapshot: HealthStatus,
  signals: PriceSignals,
  allowExecute = false
): Promise<Decision> {
  const llm = buildLlm();
  if (!llm) {
    console.warn("[Sentry] No LLM key set (OPENAI_API_KEY or ANTHROPIC_API_KEY) — using rule-based decision");
    return ruleDecision(snapshot.hf, signals);
  }

  const agent = createReactAgent({ llm, tools: makeTools(allowExecute), messageModifier: SYSTEM_PROMPT });
  const result = await agent.invoke({
    messages: [
      {
        role: "user",
        content: JSON.stringify(
          {
            snapshot: {
              healthFactor: snapshot.hf,
              debtUsd: snapshot.totalDebtBase,
              collateralUsd: snapshot.totalCollateralBase,
            },
            signals,
            threshold: config.hfThreshold,
            hardFloor: config.hfHardFloor,
            repayAmountUsdc: config.repayAmountUsdc,
            dryRun: !allowExecute || config.dryRun,
          },
          null,
          2
        ),
      },
    ],
  });

  const messages = result.messages as MsgLike[];
  const finalText = msgText(messages[messages.length - 1] ?? { _getType: () => "", content: "" });
  const parsed = parseDecisionJson(finalText);
  const fallback = ruleDecision(snapshot.hf, signals);

  return {
    risk: parsed.risk ?? fallback.risk,
    action: parsed.action ?? fallback.action,
    amountUsdc: typeof parsed.amountUsdc === "number" ? parsed.amountUsdc : fallback.amountUsdc,
    reasons: parsed.reasons?.length ? parsed.reasons : fallback.reasons,
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : fallback.confidence,
    source: "llm",
    steps: collectSteps(messages),
  };
}
