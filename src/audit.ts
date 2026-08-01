import { writeFileSync } from "node:fs";
import type { KeeperHub } from "./keeperhub.js";

type Json = Record<string, unknown>;

interface LogRow {
  nodeName?: string;
  nodeType?: string;
  status?: string;
  duration?: string;
  startedAt?: string;
  error?: string | null;
  output?: Json;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
}

function txLink(out: Json | undefined): string {
  if (!out) return "";
  const hash = text(out.transactionHash);
  if (hash) return `\`${hash.slice(0, 12)}…\` https://basescan.org/tx/${hash}`;
  const link = text(out.transactionLink);
  return link ? link : "";
}

export interface ExecutionAudit {
  id: string;
  status?: string;
  startedAt?: string;
  completedAt?: string;
  transactionHashes: string[];
  logs: LogRow[];
}

export async function fetchExecution(kh: KeeperHub, executionId: string): Promise<ExecutionAudit> {
  const raw = (await kh.getExecution(executionId)) as Json;
  const execution = (raw.execution ?? raw) as Json;
  const logs = (Array.isArray(raw.logs) ? raw.logs : Array.isArray(raw) ? raw : []) as LogRow[];

  const hashesRaw = text(execution.transactionHashes);
  let transactionHashes: string[] = [];
  if (Array.isArray(execution.transactionHashes)) {
    transactionHashes = execution.transactionHashes.map(String);
  } else if (hashesRaw) {
    try {
      const parsed = JSON.parse(hashesRaw);
      if (Array.isArray(parsed)) transactionHashes = parsed.map(String);
    } catch {
      transactionHashes = [hashesRaw];
    }
  }

  return {
    id: String(execution.id ?? executionId),
    status: text(execution.status) || undefined,
    startedAt: text(execution.startedAt) || undefined,
    completedAt: text(execution.completedAt) || undefined,
    transactionHashes,
    logs: logs.sort((a, b) => String(a.startedAt ?? "").localeCompare(String(b.startedAt ?? ""))),
  };
}

export async function renderAudit(kh: KeeperHub, executionId: string): Promise<{ audit: ExecutionAudit; markdown: string }> {
  const audit = await fetchExecution(kh, executionId);
  const lines: string[] = [];

  lines.push(`# Sentry Execution Audit — ${audit.id}`);
  lines.push("");
  lines.push(`- **Status**: \`${audit.status ?? "?"}\``);
  if (audit.startedAt) lines.push(`- **Started**: ${audit.startedAt}`);
  if (audit.completedAt) lines.push(`- **Completed**: ${audit.completedAt}`);
  if (audit.transactionHashes.length) {
    lines.push(`- **Onchain writes (${audit.transactionHashes.length})**:`);
    for (const hash of audit.transactionHashes) lines.push(`  - \`${hash}\` https://basescan.org/tx/${hash}`);
  }
  lines.push("");
  lines.push("## Chain (trigger → decision → tx → outcome)");
  lines.push("");
  for (const log of audit.logs) {
    const outcome = log.status === "success" ? "ok" : log.status === "error" ? `ERROR${log.error ? `: ${text(log.error)}` : ""}` : String(log.status ?? "?");
    lines.push(
      `- [\`${log.nodeType ?? "?"}\`] **${log.nodeName ?? "?"}** — ${outcome}` +
        (log.duration ? ` (${log.duration}ms)` : "") +
        (txLink(log.output) ? ` — ${txLink(log.output)}` : "") +
        (log.startedAt ? ` @ ${log.startedAt}` : "")
    );
  }
  lines.push("");
  lines.push("## Gas & routing evidence");
  lines.push("");
  for (const log of audit.logs) {
    const out = log.output ?? {};
    if (out.gasUsed !== undefined || out.effectiveGasPrice !== undefined) {
      lines.push(
        `- **${log.nodeName ?? "?"}**: gas=${text(out.gasUsedUnits)} units, cost=${text(out.gasUsed)} wei, effectiveGasPrice=${text(out.effectiveGasPrice)} wei`
      );
    }
  }
  lines.push("");
  lines.push("_Rendered by Sentry from KeeperHub execution logs._");
  lines.push("");

  return { audit, markdown: lines.join("\n") };
}

export async function auditToFile(kh: KeeperHub, executionId: string, outFile: string): Promise<void> {
  const { markdown } = await renderAudit(kh, executionId);
  writeFileSync(outFile, markdown, "utf8");
  console.log(`[Sentry] Audit written to ${outFile}`);
}
