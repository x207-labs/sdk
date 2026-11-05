// One run of the EVM agent against a facilitator with the relayer routes (testnet):
//
//   EVM_PRIVATE_KEY=0x… RELAYER_URL=https://… CIRCLE_CONTRACT=x207-v014.testnet SELLER_URL=https://…/api/summarize npm run start -w @x207/example-evm-agent
//
// EVM_PRIVATE_KEY is optional: without it a new key is made and only its address is printed (the key is kept in memory and lost at exit, so use it for a one-off run).
// TERMS_HASH is the circle terms hash (default 64 times `a`, the terms hash of the testnet circles). CLAIM_EPOCH and CLAIM_RECEIVER make the agent claim at the end.
import { generatePrivateKey } from "viem/accounts";
import { createEvmAgent } from "./agent.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`variable ${name} is required`);
  return value;
};
const rpcUrls = process.env.NEAR_RPC_URLS?.split(",").map((u) => u.trim()).filter(Boolean);
const agent = createEvmAgent({
  privateKey: process.env.EVM_PRIVATE_KEY || generatePrivateKey(),
  relayerUrl: required("RELAYER_URL"),
  circleContract: required("CIRCLE_CONTRACT"),
  ...(rpcUrls?.length ? { rpcUrls } : {}),
});
console.log("agent address (member id):", agent.id);

const joined = await agent.join(process.env.TERMS_HASH || "a".repeat(64));
console.log("join_evm tx:", joined.txHash, joined.stakeTxHash ? `stake tx: ${joined.stakeTxHash}` : "(no stake by the relayer)");

if (process.env.SELLER_URL) {
  const response = await agent.payFetch()(process.env.SELLER_URL);
  console.log("paid call:", response.status, await response.text());
  const settled = response.headers.get("PAYMENT-RESPONSE");
  if (settled) console.log("PAYMENT-RESPONSE", Buffer.from(settled, "base64").toString("utf8"));
}

if (process.env.CLAIM_EPOCH && process.env.CLAIM_RECEIVER) {
  const claimed = await agent.claim(Number(process.env.CLAIM_EPOCH), process.env.CLAIM_RECEIVER);
  console.log("claim_evm tx:", claimed.txHash);
}
