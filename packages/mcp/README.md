# @x207/mcp

An [MCP](https://modelcontextprotocol.io) server for x207, the mutual-credit settlement layer for x402 agent payments on NEAR. It lets a model such as Claude read a circle: its rules and members, one member's position and limit, the result of an epoch, a clearing proposal checked by the contract, the marketplace, and one order.

Status: version 0.0.1, pre-release. By default the server has **read tools only**: it signs nothing, sends nothing and holds no key. The eight **write tools** exist only on stdio, only when you turn them on, and only behind the guards below. Node 22.22.2 or newer.

## The six read tools

| Tool | What it answers | Reads |
| --- | --- | --- |
| `x207_circle_overview` | The circle and its rules, and its members | contract views `get_circle`, `get_params`; read API `GET /members` (the view `list_members` when there is no read API) |
| `x207_member_inspect` | One member: status, stake, position, credit limit | read API `GET /members/{account}` and `GET /members/{account}/limits` (the views `member` and `limit` when there is no read API) |
| `x207_epoch_report` | One clearing epoch, the current one by default: phase, deadlines, cleared ratio and settlements | contract view `get_epoch`; read API `GET /epochs/{n}`, `GET /epochs/{n}/metrics`, `GET /epochs/{n}/settlements` (the view `list_positions` when there is no read API) |
| `x207_simulate_clearing` | Whether a proposed clearing is valid, and what it would clear | contract view `simulate_clearing` |
| `x207_search_listings` | Marketplace listings, filtered by account, asset type and class | read API `GET /listings` (needs the read API) |
| `x207_order_status` | One service order, or a list of orders by party and status | read API `GET /orders/{hash}` and `GET /orders` (needs the read API) |

All six are marked `readOnlyHint: true`. Credit amounts are decimal strings in the smallest unit (6 decimals). A tool that fails returns an error result with a short reason, and a part of an answer that could not be read (for example a read API that is down) is reported in `warnings` while the rest is returned. A result longer than 100,000 characters is cut and says so.

## Configuration

Everything comes from the environment. No variable holds a secret.

| Variable | Meaning |
| --- | --- |
| `X207_CIRCLE_CONTRACT` | **Required.** The circle contract account, for example `x207-v013.testnet`. |
| `X207_CIRCLE_ID` | The circle id in the read API paths. Default `agents-main`. |
| `X207_RPC_URL` | NEAR JSON-RPC endpoints, comma separated, tried in order. Default: `https://rpc.testnet.fastnear.com` then `https://rpc.testnet.near.org` for a `.testnet` contract, otherwise the mainnet endpoints of `@x207/core`. An endpoint that fails or answers 429 hands over to the next. |
| `X207_BACKEND_URL` | Base URL of the x207 read API, for example `http://127.0.0.1:8080`. Optional; without it `x207_search_listings` and `x207_order_status` explain what is missing and the other tools answer from the contract. |
| `X207_TIMEOUT_MS` | Timeout of one RPC or read API call. Default 10000. |

## Use with Claude Desktop (stdio)

Install the package, then add the server to `claude_desktop_config.json`:

```bash
npm install -g @x207/mcp
```

```json
{
  "mcpServers": {
    "x207": {
      "command": "x207-mcp",
      "env": {
        "X207_CIRCLE_CONTRACT": "x207-v013.testnet",
        "X207_BACKEND_URL": "http://127.0.0.1:8080"
      }
    }
  }
}
```

From a checkout of the repository, build once with `npm run build` and point `command` at `node` with `"args": ["/path/to/sdk/packages/mcp/dist/cli.js"]`. Restart Claude Desktop, then ask for example: "Give me the overview of the x207 circle", "Inspect the member alice.x207-v013.testnet", or "Report epoch 1".

## Write tools (stdio only, off by default)

Set `X207_MCP_WRITE=1` and give the agent's account and keys in the environment. The HTTP server never has these tools, whatever the environment says.

| Tool | What it does | Signs with | Off unless |
| --- | --- | --- | --- |
| `x207_pay_request` | Fetches a URL; on an x207 402 it signs a credit voucher and repeats the request. The facilitator of the seller registers the voucher; this tool sends nothing to the chain. | voucher key | a voucher key |
| `x207_list_offer` | Signs a listing (what the agent offers, what it seeks) and posts it to the marketplace book. | voucher key | a voucher key and `X207_BACKEND_URL` |
| `x207_make_offer` | Signs an offer or a counter-offer (`in_reply_to`) on a listing and posts it. | voucher key | a voucher key and `X207_BACKEND_URL` |
| `x207_accept_offer` | Previews the acceptance at the backend, checks what the agent would pay, signs the bundle and posts the acceptance. | voucher key | a voucher key and `X207_BACKEND_URL` |
| `x207_confirm_milestone` | Signs a notice for a milestone of an order (`confirmed`, `disputed`, `delivered`, `cancelled`) and posts it. | voucher key | a voucher key and `X207_BACKEND_URL` |
| `x207_join` | Joins the circle and stakes USDT: `join` with the 0.35 NEAR storage deposit, then `ft_transfer_call`. | NEAR key | `X207_ALLOW_OUTFLOWS=1` and `X207_ALLOW_FULL_ACCESS_KEY=1` |
| `x207_settle` | Pays the residual the agent owes for an epoch (at most the amount due): `ft_transfer_call` with the `settle` message. | NEAR key | `X207_ALLOW_OUTFLOWS=1` and `X207_ALLOW_FULL_ACCESS_KEY=1` |
| `x207_claim` | Claims what the agent is owed for an epoch, to its own account or its Intents balance: `claim` with 1 yoctoNEAR. | NEAR key | `X207_ALLOW_FULL_ACCESS_KEY=1` |

A tool whose key or switch is missing is not listed at all. The **voucher key** is an off-chain ed25519 key of the agent (`ed25519:<base58>`); it is not a NEAR access key. The **NEAR key** is an access key of the agent's account.

| Variable | Meaning |
| --- | --- |
| `X207_MCP_WRITE` | `1` turns the write tools on. Default: off. |
| `X207_AGENT_ACCOUNT` | The NEAR account of the agent, a member of the circle. Required with `X207_MCP_WRITE=1`. |
| `X207_AGENT_VOUCHER_KEY` | Voucher secret key. Signs vouchers, listings, offers, acceptances and notices. |
| `X207_AGENT_NEAR_KEY` | NEAR secret key of the agent account. Signs the transactions of `x207_join`, `x207_settle` and `x207_claim` only. |
| `X207_MAX_SPEND_SESSION` | Most the agent may commit in one run of the server, in credit units (6 decimals). Default `1000000` (1 credit). |
| `X207_MAX_PRICE_PER_CALL` | Most one payment, offer or milestone may be. Default `100000` (0.1 credit). |
| `X207_ALLOWED_COUNTERPARTIES` | Comma separated accounts the agent may deal with. Empty: any active member of the circle. |
| `X207_ALLOW_OUTFLOWS` | `1` allows `x207_join` and `x207_settle`, which move USDT from the agent into the circle. Default off. |
| `X207_ALLOW_FULL_ACCESS_KEY` | `1` allows the NEAR key to be a full-access key. Default off. |
| `X207_ALLOW_PRIVATE_URLS` | `1` lets `x207_pay_request` fetch a URL on this machine or in a private network, for a seller you run yourself. Default off. |

### The guards

1. **Budget of the session.** Every voucher signed, every payment an acceptance would make, every milestone confirmed and every stake or residual paid counts against `X207_MAX_SPEND_SESSION`. A commitment that does not fit is refused before it is signed; one that fails afterwards is given back.
2. **Price per call.** An amount above `X207_MAX_PRICE_PER_CALL` is refused. The price in a 402 comes from the seller, so the server does not trust it: the check runs on the requirement before the voucher is signed.
3. **Risky tools are off.** `x207_join` and `x207_settle` stay off until the operator sets `X207_ALLOW_OUTFLOWS=1`.
4. **Counterparties.** The other party of a payment, offer, acceptance or milestone must be an **active member** of the circle (a contract view), must be in `X207_ALLOWED_COUNTERPARTIES` when that list is set, and is never the agent itself.
5. **Network.** The URL given to `x207_pay_request` comes from a model, so it can come from a prompt injection. The tool refuses a URL whose host is, or resolves to, a loopback, private, link-local (the metadata service of a cloud machine), carrier-grade NAT, multicast or unspecified address, and names such as `localhost`, `*.local` and `*.internal`. It does not follow redirects (the answer says where a redirect points), gives each call 30 seconds, and reads at most 1 MiB of an answer. `X207_ALLOW_PRIVATE_URLS=1` turns the address check off for a seller on your own machine.
6. **Keys.** Keys come from the environment only. No result, error or log line contains a key: every text that leaves the server is scrubbed of the configured keys and of anything shaped like an ed25519 secret key. Before a tool sends a transaction the server reads the permission of the NEAR key (`view_access_key`). **A function-call key cannot attach a deposit, and join, stake, settle and claim all attach one** (NEAR protocol rule), so with a function-call key those tools refuse and send nothing. With a full-access key they run only if `X207_ALLOW_FULL_ACCESS_KEY=1`; use a dedicated agent account with a small balance. The tools that sign with the voucher key send no transaction, so they do not need a NEAR key at all.

Also: the backend returns the terms of a bundle together with their hash, and `x207_accept_offer` refuses when the hash does not match the terms; `x207_make_offer` refuses when the listing the book returns does not hash to the hash that was asked for.

### Security limit: the balance of the agent account is the largest possible loss

A NEAR deposit cannot be attached by a function-call key, so the tools that send one (`x207_join`, `x207_settle`, `x207_claim`) need a **full-access key** of the agent account. A full-access key can do anything the account can do, and none of the guards above limits what a stolen or misused key does outside this server. So use a **dedicated agent account** that holds only what the agent may lose: whatever NEAR and USDT sit on that account is the most that can be lost. The session budget and the price cap protect against a model that misbehaves; they do not protect against someone who has the key. Leave `X207_ALLOW_FULL_ACCESS_KEY` unset, and the three tools off, if the agent only needs to pay, list, offer, accept and confirm: those tools sign with the voucher key and never need a NEAR key.

### Claude Desktop with the write tools

```json
{
  "mcpServers": {
    "x207-agent": {
      "command": "x207-mcp",
      "env": {
        "X207_CIRCLE_CONTRACT": "x207-v013.testnet",
        "X207_BACKEND_URL": "http://127.0.0.1:8080",
        "X207_MCP_WRITE": "1",
        "X207_AGENT_ACCOUNT": "agent.x207-v013.testnet",
        "X207_AGENT_VOUCHER_KEY": "ed25519:…",
        "X207_MAX_SPEND_SESSION": "500000",
        "X207_MAX_PRICE_PER_CALL": "50000"
      }
    }
  }
}
```

Keep the keys out of any file you commit. Then ask for example: "List a translation service for 0.05 credit", "Pay https://seller.example/api/summarize", or "Confirm milestone 1 of order …".

## Use over Streamable HTTP

```bash
X207_CIRCLE_CONTRACT=x207-v013.testnet X207_BACKEND_URL=http://127.0.0.1:8080 x207-mcp --http --port 3207
```

The endpoint is `POST http://127.0.0.1:3207/mcp`. It is stateless (no session) and serves **only the read tools**, so it can be shown to anybody who can already read the contract and the read API. `GET /healthz` answers 200. It listens on `127.0.0.1` unless `--host` says otherwise; put a reverse proxy with TLS and a rate limit in front of it before you expose it. On a loopback address it serves only the `Host` names of the loopback (`127.0.0.1`, `localhost`, `[::1]`), so a web page cannot reach it through DNS rebinding; behind a proxy set `X207_ALLOWED_HOSTS=mcp.example.org` (comma separated) to serve exactly those names.

To try it with the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector --cli http://127.0.0.1:3207/mcp --transport http --method tools/list
```

## Use as a library

```ts
import { configFromEnv, createX207McpServer } from "@x207/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = createX207McpServer(configFromEnv(), "stdio"); // "http" gives the read tools only
await server.connect(new StdioServerTransport());
```

## Example output (real data)

Run against the circle `x207-v013.testnet` (contract views from the testnet RPC) and a local read API (`backend`) that served the read model of that circle with its three demo accounts. The tool results below are real; long fields (signatures, hashes of the order spec) are left out and marked by the keys that remain.

`x207_member_inspect` with `{"account": "x207-demo-seller.testnet"}`:

```json
{
  "account": "x207-demo-seller.testnet",
  "member": {
    "account": "x207-demo-seller.testnet",
    "status": "active",
    "stake": "100000000",
    "limit": "80000000",
    "outstandingDebt": "0",
    "headroom": "80000000",
    "joinedAt": "2026-11-04T04:25:29Z"
  },
  "limits": {
    "items": [
      {
        "epoch": null,
        "oldLimit": "0",
        "newLimit": "80000000",
        "status": "active",
        "reason": "stake",
        "blockHeight": 276145725
      }
    ]
  },
  "source": "read API",
  "warnings": []
}
```

`x207_search_listings` with `{"account": "x207-demo-seller.testnet", "limit": 1}`:

```json
{
  "items": [
    {
      "listingHash": "6eb11d3068ba7e5f84503d9d454242e891fedd676ffd1e03324d4889a304fa41",
      "account": "x207-demo-seller.testnet",
      "offer": {
        "assetType": "near-rpc:access",
        "assetClass": "B",
        "quantity": 1,
        "value": "2000000"
      },
      "want": {
        "assetType": "usdc",
        "assetClass": "A",
        "quantity": 1,
        "value": "2000000"
      },
      "expiresAt": "2026-12-31T00:00:00Z",
      "status": "open"
    }
  ],
  "nextCursor": "eyJhIjoxfQ"
}
```

`x207_order_status` with the `hash` of the order of `x207-demo-buyer.testnet`:

```json
{
  "orderHash": "332b9bddcc9e17578ba2e55b1fd7d8c0323f7a8225f4ebc03a83b7c0668840a3",
  "buyer": "x207-demo-buyer.testnet",
  "seller": "x207-demo-seller.testnet",
  "status": "open",
  "budget": "30000000",
  "unit": "credit",
  "decimals": 6,
  "milestones": [
    {
      "index": 1,
      "amount": "10000000",
      "dueAt": 1796947200,
      "status": "open"
    },
    {
      "index": 2,
      "amount": "20000000",
      "dueAt": 1797811200,
      "status": "open"
    }
  ]
}
```

Without a read API the same server still answers `x207_circle_overview`, `x207_member_inspect`, `x207_epoch_report` and `x207_simulate_clearing` from the contract alone: on `x207-v013.testnet` `x207_circle_overview` returns `member_count` 24 and the rules (`epoch_length` 600, fees 10 and 5 bps, `prune_delay_epochs` 2), and `x207_epoch_report` for epoch 1 shows the phase `finalized` with 210 edges and 15 participants.

## Safety

- The read tools call contract views and `GET` requests only; there is no code path in them that signs, sends or changes anything. The write tools are described above and are off by default.
- Inputs are checked before any call: account ids, hashes, amounts as integer strings, at most 300 edges for a simulation, at most 200 items per page.
- Path segments are encoded, so an input cannot reach another endpoint of the read API.
- A circle on testnet reads from a testnet endpoint by default.

## Develop

```bash
npm run build          # from the repository root of sdk
npx vitest run packages/mcp
```

The tests play the NEAR RPC and the read API with a mock `fetch`, run the HTTP transport on a local port, and drive the built `x207-mcp` over stdio (that test skips itself when `dist` is not built).

## License

Apache-2.0
