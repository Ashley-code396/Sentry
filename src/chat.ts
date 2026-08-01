import { DynamicStructuredTool } from "@langchain/core/tools";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import { config, requireKh } from "./config.js";
import { KeeperHub } from "./keeperhub.js";
import { getPriceSignals } from "./signals.js";
import { readPositionPublic } from "./publicread.js";
import { checkHealth } from "./monitor.js";
import { ruleDecision } from "./decide.js";

const CHAT_SYSTEM = `You are Sentry, an autonomous position-risk agent for an Aave V3 position on Base.

You can:
- Check the current health factor, debt and collateral of a position (get_aave_account_data).
- Pull live price signals: 5-minute drawdown and volatility (get_price_signal).
- Execute a defensive action through KeeperHub — the ONLY onchain path (execute_protocol_action). Repay is blocked in dry-run mode.
- Inspect the audit trail of past executions (get_execution, list_executions).

Be concise. When you check anything, report the numbers. When you act, confirm the outcome. If you cannot reach a data source, say so clearly.`;

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
  if (config.anthropicApiKey) return new ChatAnthropic({ model: model || "claude-sonnet-4-5", temperature: 0 });
  if (config.openaiApiKey) return new ChatOpenAI({ model: model || "gpt-4o-mini", temperature: 0 });
  return null;
}

function kh(): KeeperHub {
  return new KeeperHub(requireKh());
}

function makeTools() {
  return [
    new DynamicStructuredTool({
      name: "get_aave_account_data",
      description:
        "Read the Aave V3 position of a user on Base: health factor, total debt (USD), total collateral (USD). Pass a 0x address.",
      schema: z.object({ user: z.string().describe("Aave V3 user address on Base") }),
      func: async ({ user }) =>
        JSON.stringify(
          await kh().executeProtocolAction({
            actionType: "aave-v3/get-user-account-data",
            network: config.network,
            user,
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
        "THE ONLY onchain execution path. Execute a KeeperHub protocol action. Supported: aave-v3/repay (asset, amount in wei, interestRateMode 2, onBehalfOf). Blocked when DRY_RUN=true.",
      schema: z.object({
        actionType: z.string(),
        asset: z.string().optional(),
        amount: z.string().optional(),
        interestRateMode: z.string().optional(),
      }),
      func: async ({ actionType, asset, amount, interestRateMode }) => {
        if (config.dryRun) {
          return `DRY-RUN: onchain execution blocked. Would execute ${actionType} asset=${asset ?? "n/a"} amount=${amount ?? "n/a"}.`;
        }
        return JSON.stringify(
          await kh().executeProtocolAction({
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
    new DynamicStructuredTool({
      name: "list_executions",
      description: "List the most recent KeeperHub executions with status, timestamps and transaction hashes.",
      schema: z.object({}),
      func: async () => JSON.stringify(await kh().restGet("/executions")),
    }),
    new DynamicStructuredTool({
      name: "get_execution",
      description: "Fetch the audit trail of one KeeperHub execution by id: per-step logs, gas, tx hashes.",
      schema: z.object({ executionId: z.string() }),
      func: async ({ executionId }) => JSON.stringify(await kh().getExecution(executionId)),
    }),
  ];
}

export interface ChatResult {
  reply: string;
  steps: Array<{ name: string; args: string; result: string }>;
  source: "llm" | "rule";
}

export async function chatWithSentry(message: string): Promise<ChatResult> {
  const llm = buildLlm();

  if (!llm) {
    return { reply: await fallbackReply(message), steps: [], source: "rule" };
  }

  const agent = createReactAgent({ llm, tools: makeTools(), messageModifier: CHAT_SYSTEM });
  const result = await agent.invoke({ messages: [{ role: "user", content: message }] });
  const messages = result.messages as MsgLike[];

  const steps: ChatResult["steps"] = [];
  for (const m of messages) {
    for (const call of m.tool_calls ?? []) {
      steps.push({ name: call.name, args: JSON.stringify(call.args), result: "" });
    }
    if (m._getType() === "tool" && m.name) {
      const last = steps.map((s, i) => ({ s, i })).filter(({ s }) => s.name === m.name && s.result === "").pop();
      if (last) last.s.result = msgText(m);
    }
  }

  return { reply: msgText(messages[messages.length - 1] ?? { _getType: () => "", content: "" }), steps, source: "llm" };
}

async function fallbackReply(message: string): Promise<string> {
  const address = config.userAddress;
  const lower = message.toLowerCase();
  const wantsStatus =
    /health|position|status|health factor|hf|risk|collateral|debt|account/.test(lower);

  if (!address && wantsStatus) {
    return "No USER_ADDRESS is configured. Set it in .env (npm run onboard) or ask me to check a specific address.\n\nTip: add an OPENAI_API_KEY (or ANTHROPIC_API_KEY) and I can reason conversationally with live tools.";
  }

  let health;
  try {
    if (config.khApiKey) {
      health = await checkHealth(kh());
    } else {
      health = await readPositionPublic(address);
    }
  } catch (err) {
    return `Could not read the position for ${address}: ${err instanceof Error ? err.message : err}`;
  }

  const signals = await getPriceSignals().catch(() => ({ priceUsd: 0, drawdownPct: 0, volatilityPct: 0 }));
  const decision = ruleDecision(health.hf, signals);

  const head = wantsStatus || lower.includes("verdict") ? "Current position" : `Position for ${address}`;
  const lines = [
    `${head}:`,
    `- Health factor: ${health.hf.toFixed(3)}`,
    `- Collateral: $${health.totalCollateralBase.toFixed(2)}  ·  Debt: $${health.totalDebtBase.toFixed(2)}`,
    signals.priceUsd > 0
      ? `- ETH $${signals.priceUsd.toFixed(2)} · 5-min drawdown ${signals.drawdownPct.toFixed(2)}% · vol ${signals.volatilityPct.toFixed(2)}%`
      : "- market feed unreachable",
    `- Verdict: ${decision.action.toUpperCase()}${decision.amountUsdc ? ` ${decision.amountUsdc} USDC` : ""} (${decision.risk}, ${Math.round(decision.confidence * 100)}%)`,
    ...decision.reasons.map((r) => `  • ${r}`),
    "",
    "Add an LLM key (OPENAI_API_KEY / ANTHROPIC_API_KEY) for full conversational reasoning and tool use.",
  ];
  return lines.join("\n");
}
