# Sentry — Autonomous Position-Risk Agent

Sentry watches an Aave V3 position on Base, reasons about the risk with a LangChain agent, and defends the position — partial repay, top-up, or close — with every onchain action executed through [KeeperHub MCP](https://docs.keeperhub.com/ai-tools/mcp-server). No custom transaction paths.

## Quickstart

### 60 seconds → first verdict (no key, no tokens)

```bash
npm install
npm run demo -- 0xYourAaveAddressOnBase   # any position, read-only, free
```

Sentry reads the position straight from the Aave V3 Pool on Base (public RPC demo mode), pulls 5-minute market signals, runs the decision layer, and prints a verdict with reasons.

### 5 minutes → first defensive action

```bash
npm run onboard    # guided .env setup wizard
npm run doctor     # verify every prerequisite (✅/❌)
npm run loop       # monitor every 60s and defend autonomously
```

The only things you need: a KeeperHub API key (`app.keeperhub.com → Settings → API keys`), a connected wallet integration, and a small Aave position on Base (see [Setup](#setup)).

## Commands

| Command | What it does |
| --- | --- |
| `npm run demo -- <addr>` | Read-only live verdict for any Aave V3 address on Base |
| `npm run watch -- <addr>` | Live terminal dashboard (health-factor meter, signals, verdict) |
| `npm run onboard` | Interactive setup wizard (writes `.env`) |
| `npm run doctor` | Preflight checklist with clear next steps |
| `npm run check` | Print current health factor (via KeeperHub) |
| `npm run decide` | LangChain agent reasons over HF + signals (dry-run) |
| `npm run defend` | Force a partial USDC repay via KeeperHub |
| `npm run loop` | Monitor every 60s; on breach, reason then defend |
| `npm run web` | Live web dashboard + chat (http://localhost:4321) |
| `npm run mcp` | Expose Sentry as an MCP server (stdio) |
| `npm run publish` | Publish the risk-check as a paid x402/MPP workflow |
| `npm run paycheck` | Pay-per-call the published risk-check |
| `npm run executions` | List recent KeeperHub executions |
| `npm run audit -- <execId>` | Render the full trigger → decision → tx → outcome audit |
| `npm run stage-failure` | Run a low-gas repay to exercise simulation/retry |

## Reasoning layer (LangChain)

- `signals.ts` — pulls 5-min ETH/USDC candles (Binance) and computes **drawdown %** (fall from 5-min peak) and **volatility %**.
- `agent.ts` — a LangChain ReAct agent (`createReactAgent`) with three tools that all route through KeeperHub: `get_aave_account_data`, `get_price_signal`, and `execute_protocol_action` (the only onchain path). It returns a structured decision `{risk, action, amountUsdc, reasons, confidence}` plus its full tool-call trace.
- `decide.ts` — deterministic fallback when no `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` is set.

Decision rule: `HF <= 1.05` → repay immediately. `HF < threshold` **and** drawdown ≥ 3% → partial repay (real cascade risk). `HF < threshold` with tiny drawdown → hold (noise, don't burn gas).

## Setup

1. **KeeperHub account** — sign up at [app.keeperhub.com](https://app.keeperhub.com), create an org API key (`kh_`), and connect a wallet integration (required for write actions).
2. **Fund on Base** — a few cents of ETH for gas (or enable KeeperHub gas sponsorship) and a few USDC for the repay. Base is cheap: a full demo runs on ~$20–30.
3. **Open an Aave position** — supply collateral and borrow on [Aave V3 Base](https://app.aave.com/?marketName=proto_base_v3) so there's a health factor to defend. For a realistic breach, borrow close to your max so HF lands around 1.1–1.3.
4. **Configure** — `npm run onboard` (writes `.env`), then `npm run doctor`.

| Variable | Description |
| --- | --- |
| `KH_API_KEY` | KeeperHub org API key (`kh_…`) |
| `USER_ADDRESS` | Wallet with the Aave position |
| `HF_THRESHOLD` | Defend trigger (default `1.25`) |
| `REPAY_AMOUNT_USDC` | Partial repay size (default `5`) |
| `NETWORK` | Chain ID (default `8453` = Base) |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | Enables LLM reasoning (optional) |
| `DRY_RUN` | `true` = decide only, never execute (safe demo mode) |
| `PORT` | Web dashboard port (default `4321`) |

## Web dashboard + chat

```bash
npm run web     # → http://localhost:4321  (add ?addr=0x… to watch a position)
```

- **Dashboard** — live health-factor meter, collateral/debt, market signals, verdict with reasons, and the audit trail (click an execution to see the full trigger → decision → tx → outcome chain).
- **Chat** — talk to the LangChain agent in plain English ("what is my health factor?", "should I defend?"). It uses KeeperHub tools for reads, audits, and gated execution.
- **Defend button** — triggers a partial repay through KeeperHub (blocked while `DRY_RUN=true`).

API: `GET /api/status?addr=0x…`, `POST /api/chat {message}`, `GET /api/executions`, `GET /api/audit/:id`, `POST /api/defend`.

## Sentry as an MCP server

`npm run mcp` exposes Sentry's tools over MCP (stdio) so any MCP client — Claude Desktop, Cursor, Windsurf — can use it. Tools: `sentry_status`, `get_aave_account_data`, `get_price_signal`, `execute_protocol_action`, `defend`, `list_executions`, `get_execution`.

Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sentry": {
      "command": "npx",
      "args": ["tsx", "src/mcp-server.ts"],
      "cwd": "/path/to/hackathons/keeperhub/sentry"
    }
  }
}
```

Then ask Claude: "what is the health factor of 0x…?" or "run sentry_status for my address".

## Phase 3 — Paid x402 risk-check

Publish the risk-check as a marketplace workflow, then pay-per-call over x402 (Base USDC) / MPP (Tempo USDC.e).

```bash
npm run publish     # create + list "sentry-risk-check" workflow at $0.01/call
npm run paycheck    # call it; on HTTP 402, capture the x402 challenge and settle
```

- `publish.ts` builds the workflow (Manual trigger → `aave-v3/get-user-account-data` → code decision node), publishes via `list_workflow`, and prints the per-workflow MCP + REST call URLs.
- `paycheck.ts` posts to `/api/mcp/workflows/{slug}/call`. A paid workflow returns `HTTP 402` with an x402 challenge; set `KH_WALLET_MCP_URL` to a remote `@keeperhub/wallet` MCP server to auto-pay (`call_workflow` tool) or settle manually.

## Phase 4 — Reliability & audit trail

```bash
npm run executions            # list recent KeeperHub executions
npm run audit -- <execId>     # render trigger → decision → tx → outcome to stdout + audit.md
npm run stage-failure         # create + run a low-gas repay workflow to exercise simulation/retry
```

- `audit.ts` pulls `get_execution` (status + per-step logs) and renders the full chain, including `gasUsed`, `effectiveGasPrice`, tx hashes and timestamps — the "reliability and observability" evidence.
- `stage-failure` deliberately under-funds gas on the repay action so you can narrate KeeperHub's simulation-before-submit / retry / backoff from the audit log. For a real gas-spike demo, run `npm run defend` during a congestion window, then `npm run audit` the run.

## Architecture

```mermaid
flowchart LR
  CLI["Sentry CLI\n(onboard / doctor / demo / watch / loop)"]
  Monitor["monitor.ts\nget-user-account-data"]
  Signals["signals.ts\n5-min drawdown + vol"]
  Agent["agent.ts\nLangChain ReAct agent"]
  Defend["defend.ts\npartial USDC repay"]
  KH["KeeperHub MCP\napp.keeperhub.com/mcp"]
  Aave["Aave V3 Pool\nBase (8453)"]

  CLI --> Monitor
  CLI --> Signals
  CLI --> Agent
  CLI --> Defend
  Monitor --> KH
  Signals -. HTTP .-> Binance
  Agent --> KH
  Defend --> KH
  KH --> Aave
```

## Troubleshooting

- **`npm run doctor` flags something** — it tells you exactly what to fix; fix and re-run.
- **Position reads as `HF 0.000`** — that address has no borrow on Aave V3 Base, or it's a no-position wallet. Use the address that actually holds the position.
- **`defend` fails with no execution ID** — confirm the wallet integration is connected and funded in KeeperHub, and the USDC approval is set.
- **LLM not reasoning** — set `OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`) and re-run `npm run decide`. Without a key, Sentry uses the rule-based decision.
- **KeeperHub action slugs changed** — verify at runtime with `search_protocol_actions` (Sentry does this before relying on them).

## Notes

- Sentry uses KeeperHub MCP exclusively for every onchain action — the only non-KeeperHub network reads are the public price feed (Binance) and the read-only demo fallback (Base public RPC).
