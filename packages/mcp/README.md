# @x207/mcp

An [MCP](https://modelcontextprotocol.io) server for x207, the mutual-credit settlement layer for x402 agent payments on NEAR. It lets a model such as Claude read a circle: its rules and members, one member's position and limit, the result of an epoch, a clearing proposal checked by the contract, the marketplace, and one order.

Status: version 0.0.1, pre-release, **read tools only**. Nothing here signs or sends a transaction, and the server holds no key. Node 22.22.2 or newer.

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

## Use over Streamable HTTP

```bash
X207_CIRCLE_CONTRACT=x207-v013.testnet X207_BACKEND_URL=http://127.0.0.1:8080 x207-mcp --http --port 3207
```

The endpoint is `POST http://127.0.0.1:3207/mcp`. It is stateless (no session) and serves **only the read tools**, so it can be shown to anybody who can already read the contract and the read API. `GET /healthz` answers 200. It listens on `127.0.0.1` unless `--host` says otherwise; put a reverse proxy with TLS and a rate limit in front of it before you expose it.

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

- The tools call contract views and `GET` requests only; there is no code path that signs, sends or changes anything.
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
