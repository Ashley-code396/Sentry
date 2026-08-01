/**
 * Thin HTTP client for KeeperHub remote MCP at https://app.keeperhub.com/mcp
 *
 * All onchain actions go through MCP tools — never custom tx paths.
 * Confirm action slugs at runtime via search_protocol_actions before relying on them.
 */

const MCP_URL = "https://app.keeperhub.com/mcp";
const REST_URL = "https://app.keeperhub.com/api";
const PROTOCOL_VERSION = "2024-11-05";

type McpResult = { content?: Array<{ type: string; text: string }>; isError?: boolean };

export class KeeperHub {
  private sessionId: string | null = null;
  private requestId = 0;

  constructor(
    private readonly apiKey: string,
    private readonly mcpUrl: string = MCP_URL
  ) {}

  // -- protocol actions (DeFi) --

  async executeProtocolAction(args: Record<string, unknown>): Promise<unknown> {
    return this.callTool("execute_protocol_action", args);
  }

  async searchProtocolActions(query?: string): Promise<unknown> {
    return this.callTool("search_protocol_actions", query ? { query } : {});
  }

  async getDirectExecutionStatus(executionId: string): Promise<unknown> {
    return this.callTool("get_direct_execution_status", { executionId });
  }

  async getWalletIntegration(): Promise<unknown> {
    return this.callTool("get_wallet_integration", {});
  }

  // -- workflows --

  async createWorkflow(payload: Record<string, unknown>): Promise<unknown> {
    return this.callTool("create_workflow", payload);
  }

  async getWorkflow(workflowId: string): Promise<unknown> {
    return this.callTool("get_workflow", { workflowId });
  }

  async updateWorkflow(workflowId: string, payload: Record<string, unknown>): Promise<unknown> {
    return this.callTool("update_workflow", { workflowId, ...payload });
  }

  async executeWorkflow(workflowId: string, input?: Record<string, unknown>): Promise<unknown> {
    return this.callTool("execute_workflow", { workflowId, input: input ?? {} });
  }

  async getExecution(executionId: string): Promise<unknown> {
    return this.callTool("get_execution", { executionId });
  }

  async getExecutionStatus(executionId: string): Promise<unknown> {
    return this.callTool("get_execution_status", { executionId });
  }

  async getExecutionLogs(executionId: string): Promise<unknown> {
    return this.callTool("get_execution_logs", { executionId });
  }

  // -- marketplace --

  async searchWorkflows(query?: string): Promise<unknown> {
    return this.callTool("search_workflows", query ? { query } : {});
  }

  async getWorkflowListing(slug: string): Promise<unknown> {
    return this.callTool("get_workflow_listing", { slug });
  }

  async listWorkflow(payload: Record<string, unknown>): Promise<unknown> {
    return this.callTool("list_workflow", payload);
  }

  async updateWorkflowListing(payload: Record<string, unknown>): Promise<unknown> {
    return this.callTool("update_workflow_listing", payload);
  }

  async unlistWorkflow(slug: string): Promise<unknown> {
    return this.callTool("unlist_workflow", { slug });
  }

  async callWorkflow(slug: string, inputs: Record<string, unknown>): Promise<unknown> {
    return this.callTool("call_workflow", { slug, inputs });
  }

  // -- REST (org-scoped) --

  async restGet(path: string): Promise<unknown> {
    const res = await fetch(`${REST_URL}${path}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`KeeperHub REST ${path} error (${res.status})`);
    return res.json();
  }

  async callWorkflowREST(slug: string, input: Record<string, unknown>): Promise<{ status: number; headers: Headers; bodyText: string }> {
    const res = await fetch(`${REST_URL}/mcp/workflows/${slug}/call`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return { status: res.status, headers: res.headers, bodyText: await res.text() };
  }

  // -- low-level --

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.invoke(name, args);
  }

  private async invoke(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureSession();
    const result = (await this.post({
      jsonrpc: "2.0",
      id: ++this.requestId,
      method: "tools/call",
      params: { name, arguments: args },
    })) as McpResult | undefined;

    if (result?.isError) {
      throw new Error(result.content?.[0]?.text ?? `KeeperHub tool error: ${name}`);
    }

    const text = result?.content?.[0]?.text;
    if (typeof text === "string") {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    return result;
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionId) return;

    const res = await fetch(this.mcpUrl, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.requestId,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "Sentry", version: "0.1.0" },
        },
      }),
    });

    if (!res.ok) throw new Error(`KeeperHub init failed (${res.status})`);
    const sid = res.headers.get("mcp-session-id");
    if (!sid) throw new Error("KeeperHub did not return mcp-session-id");
    this.sessionId = sid;
  }

  private async post(body: object, attempt = 0): Promise<unknown> {
    if (!this.sessionId) throw new Error("No MCP session");

    const res = await fetch(this.mcpUrl, {
      method: "POST",
      headers: { ...this.headers(), "mcp-session-id": this.sessionId },
      body: JSON.stringify(body),
    });

    if ((res.status === 401 || res.status === 404) && attempt < 1) {
      this.sessionId = null;
      await this.ensureSession();
      return this.post(body, attempt + 1);
    }

    if (!res.ok) throw new Error(`KeeperHub MCP error (${res.status})`);

    const json = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(`KeeperHub RPC: ${json.error.message}`);
    return json.result;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.apiKey}`,
    };
  }
}
