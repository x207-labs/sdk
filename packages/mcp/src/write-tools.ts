// The write tools of the x207 MCP server (SD-082): x207_pay_request, x207_list_offer, x207_make_offer, x207_accept_offer, x207_confirm_milestone, x207_join, x207_settle, x207_claim.
// They exist only on stdio and only with X207_MCP_WRITE=1 (see write-config.ts). Five of them sign with the VOUCHER key and send nothing to the chain (a voucher, a listing, an offer, an
// acceptance, a notice: the facilitator or the backend does the rest); three send a NEAR transaction with the NEAR key (join and stake, settle, claim). Every tool first passes the guards of
// guards.ts, and no result, error or log holds a key.
import { createHash, randomBytes } from "node:crypto";
import {
  buildClaimCall, buildSettleTransferCall, counterOffer, listingHash, termsHash, nep413SigningHash, onboardMember, postListing, signBundle, signHash, voucherPublicKey,
  type BundleTerms, type CircleViewFn, type ContractAbi, type ContractCall, type Listing, type Offer,
} from "@x207/core";
import { wrapFetchWithPayment } from "@x402/fetch";
import { evmSignerFromPrivateKey } from "@x207/core/evm";
import { X207PaymentClient, headroomFromRpc } from "@x207/scheme";
import { z } from "zod";
import type { BackendGet, BackendPost } from "./backend.js";
import type { McpConfig } from "./config.js";
import { Guards, type NearKeyKind } from "./guards.js";
import { assertPublicUrl, createPinnedFetch, defaultResolver, readCapped, type HostResolver } from "./net-guard.js";
import { ToolError, type ToolContext, type ToolDef } from "./tools.js";
import type { WriteConfig } from "./write-config.js";

export interface WriteRuntime {
  cfg: WriteConfig;
  guards: Guards;
  /** Signs and sends a NEAR transaction with the NEAR key; waits for finality. */
  send: (call: ContractCall) => Promise<unknown>;
  /** What kind of access key the NEAR key is on the agent account. */
  keyKind: () => Promise<NearKeyKind>;
  /** The fetch that pays an x402 402 with an x207 voucher; created on first use and kept for the session, so the sequence numbers of the vouchers go on. */
  payFetch: () => typeof fetch;
  post: BackendPost | null;
  now: () => number;
  /** Resolves a host name for the SSRF guard of x207_pay_request. */
  resolve: HostResolver;
}

const ACCOUNT = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/, "a NEAR account id");
const HASH64 = z.string().regex(/^[0-9a-f]{64}$/, "64 lowercase hex characters");
const AMOUNT = z.string().regex(/^[1-9]\d{0,37}$/, "a positive integer string in credit units (6 decimals)");
const EPOCH = z.number().int().min(1).max(4_294_967_295);
const ASSET_TYPE = z.string().regex(/^[a-z0-9._:-]{1,64}$/, "lowercase asset type such as service:summary");
const CLASS = z.enum(["A", "B", "C", "D"]);

/** The most that x207_pay_request reads of one answer. */
export const MAX_PAID_BODY_BYTES = 1_048_576;

const w = (ctx: ToolContext): WriteRuntime => {
  if (ctx.write === undefined) throw new ToolError("the write tools are off: set X207_MCP_WRITE=1 (stdio only)");
  return ctx.write;
};
const needPost = (rt: WriteRuntime, tool: string): BackendPost => {
  if (rt.post === null) throw new ToolError(`${tool} needs the x207 read API and marketplace book: set X207_BACKEND_URL`);
  return rt.post;
};
/**
 * After a commitment failed: the amount goes back to the budget only when it is certain that nothing was committed (a refusal of ours, a 4xx answer of the book, a contract that said no). A timeout, a 5xx
 * or an unknown error may have committed it, so the amount stays counted and the model is told that the outcome is unknown (cross review UM-112, F3).
 */
export function keepIfUnknown(rt: { guards: Guards }, amount: bigint, error: unknown): unknown {
  const status = (error as { status?: unknown }).status;
  const certain = error instanceof ToolError || (error instanceof Error && error.name === "BackendError" && typeof status === "number" && status >= 400 && status < 500)
    || (error instanceof Error && error.name === "ContractCallError" && (error as { code?: unknown }).code !== null && (error as { code?: unknown }).code !== undefined);
  if (certain) {
    rt.guards.release(amount);
    return error;
  }
  return new ToolError(`the outcome is unknown (${error instanceof Error ? error.message : String(error)}); the amount of ${amount} stays counted in this session until the state is looked at`);
}

const needVoucher = (rt: WriteRuntime, tool: string): `ed25519:${string}` => {
  if (rt.cfg.voucherKey === null) throw new ToolError(`${tool} signs with the voucher key: set X207_AGENT_VOUCHER_KEY${(rt.cfg.evmKey ?? null) !== null ? " (not available with X207_EVM_PRIVATE_KEY: an EVM agent only pays with x207_pay_request)" : ""}`);
  return rt.cfg.voucherKey;
};
const needGet = (ctx: ToolContext, tool: string): BackendGet => {
  if (ctx.backend === null) throw new ToolError(`${tool} needs the x207 read API: set X207_BACKEND_URL`);
  return ctx.backend;
};

// ---- the shapes the read API gives for a listing and an offer, turned back into the signed documents ----
interface ListingView {
  listingHash: string;
  account: string;
  offer: { assetType: string; assetClass: Listing["offer"]["asset_class"]; quantity: number; value: string };
  want: { assetType: string; assetClass: Listing["want"]["asset_class"]; quantity: number; value: string };
  terms: string;
  detail: string;
  expiresAt: string;
  discountBps: number;
  acceptPayment: boolean;
  discoverable: boolean;
  nonce: string;
  status: string;
}
interface OfferView { offerHash: string; proposer: string; counterparty: string; round: number; mode: "pay" | "barter"; value: string; quantity: number; deliverBy: string }

const seconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
const listingOf = (v: ListingView, circle: string): Listing => ({
  circle, account: v.account,
  offer: { asset_type: v.offer.assetType, asset_class: v.offer.assetClass, quantity: v.offer.quantity, value: v.offer.value },
  want: { asset_type: v.want.assetType, asset_class: v.want.assetClass, quantity: v.want.quantity, value: v.want.value },
  terms: v.terms, detail: v.detail, expires_at: seconds(v.expiresAt), discount_bps: v.discountBps, accept_payment: v.acceptPayment, discoverable: v.discoverable, nonce: v.nonce,
});
const offerOf = (v: OfferView, listingHash: string, circle: string): Offer => ({
  circle, listing_hash: listingHash, proposer: v.proposer, round: v.round, mode: v.mode, value: v.value, quantity: v.quantity, deliver_by: seconds(v.deliverBy),
});

/** NEP-413 over sha256(json), recipient the circle contract: the signature of every notice of the book (orders, invoices). */
const signNotice = (contract: string, notice: object, secretKey: `ed25519:${string}`): string => {
  const json = JSON.stringify(notice);
  return signHash(nep413SigningHash(json, createHash("sha256").update(json).digest(), contract), secretKey);
};

const circleRecord = async (ctx: ToolContext): Promise<{ usdt_token_id: string }> => (await ctx.view("get_circle", {})) as { usdt_token_id: string };

export const WRITE_TOOLS: ToolDef[] = [
  {
    name: "x207_pay_request",
    title: "Pay an x402 endpoint with a voucher",
    description:
      "Pay for an x402 resource with credit: fetches the URL and, on a 402 with an x207 payment request, signs a voucher and repeats the request, then returns the paid response. Nothing goes to the chain here; the seller's facilitator registers the voucher, and the debt is netted at the end of the epoch. Refused (with the reason) above X207_MAX_PRICE_PER_CALL, over the X207_MAX_SPEND_SESSION budget, or when the payee is not an active allowed member; the price in the 402 is never trusted. A non-402 answer is returned as it is, unpaid.",
    access: "write",
    inputSchema: {
      url: z.string().url().max(2048).describe("http or https URL of the paid resource."),
      method: z.enum(["GET", "POST"]).default("GET").describe("HTTP method of the request; GET when left out."),
      body: z.string().max(100_000).optional().describe("Body of a POST, sent as it is (JSON text)."),
    },
    handler: async (args, ctx) => {
      const rt = w(ctx);
      if ((rt.cfg.evmKey ?? null) === null) needVoucher(rt, "x207_pay_request");
      const url = new URL(args.url as string);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new ToolError("refused: the URL must be http or https");
      if (url.username !== "" || url.password !== "") throw new ToolError("refused: the URL must not carry credentials");
      // the URL comes from a model: a place that a paid request has no business with (the metadata service of a cloud machine, a service on this machine) is refused before anything is sent
      if (!rt.cfg.allowPrivateUrls) {
        try {
          await assertPublicUrl(url, rt.resolve);
        } catch (error) {
          throw new ToolError((error as Error).message);
        }
      }
      // no redirect is followed (a redirect to a private address would walk around the guard), the call has a time limit, and the answer is read up to a limit
      const init: RequestInit = { method: args.method as string, redirect: "manual", signal: AbortSignal.timeout(30_000), ...(args.body !== undefined ? { body: args.body as string, headers: { "content-type": "application/json" } } : {}) };
      let response: Response;
      try {
        response = await rt.payFetch()(url.toString(), init);
      } catch (error) {
        throw new ToolError(`payment not made or request failed: ${(error as Error).message}`);
      }
      const { text, cut } = await readCapped(response, MAX_PAID_BODY_BYTES);
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      const settle = response.headers.get("payment-response");
      let refusal: string | undefined;
      const required = response.headers.get("payment-required");
      if (response.status === 402 && required !== null) {
        try {
          refusal = (JSON.parse(Buffer.from(required, "base64").toString("utf8")) as { error?: string }).error;
        } catch {
          // an unreadable header: the status and the body say what there is
        }
      }
      return {
        status: response.status, ok: response.ok, paid: settle !== null, ...(refusal !== undefined ? { paymentRefusal: refusal } : {}), ...(settle !== null ? { paymentResponse: settle.slice(0, 2000) } : {}),
        ...(location !== null ? { location, note: "a redirect is not followed by this tool" } : {}),
        contentType: response.headers.get("content-type"), body: text.length > 50_000 ? `${text.slice(0, 50_000)}… cut` : cut ? `${text}… cut at ${MAX_PAID_BODY_BYTES} bytes` : text,
        session: { spent: rt.guards.spent.toString(), remaining: rt.guards.remaining.toString() },
      };
    },
  },
  {
    name: "x207_list_offer",
    title: "List something on the marketplace",
    description:
      "Publish a listing on the circle's marketplace: signs with the voucher key what the agent offers and what it seeks in return, and posts it. Use x207_make_offer to answer someone else's listing. Values are credit units (6 decimals). Returns the listing hash; moves no money. Fails if the read API or the voucher key is not configured.",
    access: "write",
    inputSchema: {
      offer_asset_type: ASSET_TYPE.describe("Type of what the agent offers, e.g. service:summary."), offer_class: CLASS.describe("Settlement class of the offered asset."), offer_quantity: z.number().int().min(1).max(1_000_000).describe("Units offered."), offer_value: AMOUNT.describe("Value of the offer in credit, smallest unit (6 decimals)."),
      want_asset_type: ASSET_TYPE.describe("Type of what the agent seeks in return."), want_class: CLASS.describe("Settlement class of the wanted asset."), want_quantity: z.number().int().min(1).max(1_000_000).describe("Units wanted."), want_value: AMOUNT.describe("Value of the wanted side in credit, smallest unit."),
      terms: z.string().max(1000).regex(/^[\x20-\x7e]*$/, "printable ASCII").default(""),
      detail: z.string().max(4000).regex(/^[\x20-\x7e]*$/, "printable ASCII").default(""),
      expires_in_hours: z.number().int().min(1).max(24 * 90).default(72).describe("Hours until the listing expires (default 72, at most 90 days)."),
      discount_bps: z.number().int().min(0).max(10_000).default(0).describe("Discount in basis points (100 = 1%) if the buyer pays in credit; 0 for none."),
      accept_payment: z.boolean().default(true).describe("Whether offers in pay mode (credit) are welcome, besides barter."),
      discoverable: z.boolean().default(true).describe("Whether x207_search_listings shows the listing; false keeps it reachable by hash only."),
    },
    handler: async (a, ctx) => {
      const rt = w(ctx);
      const key = needVoucher(rt, "x207_list_offer");
      const post = needPost(rt, "x207_list_offer");
      const listing: Listing = {
        circle: ctx.circleContract, account: rt.cfg.account,
        offer: { asset_type: a.offer_asset_type as string, asset_class: a.offer_class as Listing["offer"]["asset_class"], quantity: a.offer_quantity as number, value: a.offer_value as string },
        want: { asset_type: a.want_asset_type as string, asset_class: a.want_class as Listing["want"]["asset_class"], quantity: a.want_quantity as number, value: a.want_value as string },
        terms: a.terms as string, detail: a.detail as string, expires_at: Math.floor(rt.now() / 1000) + (a.expires_in_hours as number) * 3600,
        discount_bps: a.discount_bps as number, accept_payment: a.accept_payment as boolean, discoverable: a.discoverable as boolean, nonce: `mcp-${randomBytes(6).toString("hex")}`,
      };
      const signed = postListing(listing, key);
      const view = await post("/listings", { listing: signed.listing, signature: signed.signature });
      return { listingHash: signed.listing_hash, listing: view };
    },
  },
  {
    name: "x207_make_offer",
    title: "Make or counter an offer on a listing",
    description:
      "Answer a listing with an offer (mode pay in credit, or barter): signs it with the voucher key and posts it. To counter an offer, set `in_reply_to` to the hash of the offer being answered; use x207_accept_offer to take an offer instead. An offer is a proposal, not a payment, but its value is held to X207_MAX_PRICE_PER_CALL and the other party must be an allowed, active member. Refused if the listing's hash does not verify.",
    access: "write",
    inputSchema: {
      listing_hash: HASH64.describe("Hash of the listing to answer, from x207_search_listings."), mode: z.enum(["pay", "barter"]).describe("pay: credit voucher; barter: goods for goods."), value: AMOUNT.describe("Value of the offer in credit, smallest unit (6 decimals)."), quantity: z.number().int().min(1).max(1_000_000).default(1).describe("Units asked for (default 1)."),
      deliver_in_hours: z.number().int().min(1).max(24 * 365).default(24).describe("Hours within which delivery is promised (default 24)."), in_reply_to: HASH64.optional().describe("Hash of the offer being countered; leave out for a first offer."),
    },
    handler: async (a, ctx) => {
      const rt = w(ctx);
      const key = needVoucher(rt, "x207_make_offer");
      const post = needPost(rt, "x207_make_offer");
      const get = needGet(ctx, "x207_make_offer");
      const hash = a.listing_hash as string;
      const lv = (await get(`/listings/${hash}`)) as ListingView;
      const listing = listingOf(lv, ctx.circleContract);
      if (listingHash(listing) !== hash) throw new ToolError(`refused: the listing the book returned for ${hash} does not hash to ${hash}`);
      let previous: Offer | undefined;
      let other = listing.account;
      if (a.in_reply_to !== undefined) {
        const items = ((await get(`/listings/${hash}/offers`)) as { items: OfferView[] }).items;
        const prev = items.find((o) => o.offerHash === a.in_reply_to);
        if (prev === undefined) throw new ToolError(`offer ${a.in_reply_to} is not on listing ${hash}`);
        previous = offerOf(prev, hash, ctx.circleContract);
        other = prev.proposer === rt.cfg.account ? prev.counterparty : prev.proposer;
      }
      // the lister too, not only the party of the offer that is answered: an offer on the listing of somebody outside the list is a proposal to that somebody (cross review UM-112, F5)
      await rt.guards.counterparty(listing.account);
      if (other !== listing.account) await rt.guards.counterparty(other);
      rt.guards.price(BigInt(a.value as string), "the value of the offer");
      const signed = counterOffer(
        { listing, proposer: rt.cfg.account, mode: a.mode as "pay" | "barter", value: a.value as string, quantity: a.quantity as number, deliver_by: Math.floor(rt.now() / 1000) + (a.deliver_in_hours as number) * 3600, ...(previous ? { previous } : {}), now: Math.floor(rt.now() / 1000) },
        key,
      );
      const view = await post(`/listings/${hash}/offers`, { offer: signed.offer, signature: signed.signature, ...(a.in_reply_to !== undefined ? { inReplyTo: a.in_reply_to } : {}) });
      return { offerHash: signed.offer_hash, round: signed.offer.round, offer: view };
    },
  },
  {
    name: "x207_accept_offer",
    title: "Accept an offer",
    description:
      "Accept an offer on a listing. The backend first previews the effect (a payment, or a netting bundle that cancels debts in a cycle); the tool refuses if the agent would pay more than X207_MAX_PRICE_PER_CALL or what is left of X207_MAX_SPEND_SESSION, or if another party is not an allowed, active member. Otherwise it signs with the voucher key, posts the acceptance and returns the preview and the result.",
    access: "write",
    inputSchema: { listing_hash: HASH64.describe("Hash of the listing."), offer_hash: HASH64.describe("Hash of the offer to accept, from the listing's offers.") },
    handler: async (a, ctx) => {
      const rt = w(ctx);
      const key = needVoucher(rt, "x207_accept_offer");
      const post = needPost(rt, "x207_accept_offer");
      const base = `/listings/${a.listing_hash}/offers/${a.offer_hash}`;
      const preview = (await post(`${base}/preview`, { account: rt.cfg.account })) as {
        kind: "payment" | "bundle"; epoch: number; payment: { payer: string; payee: string; amount: string } | null;
        bundle: { terms: BundleTerms; participants: string[] } | null;
      };
      let outgoing = 0n;
      const others = new Set<string>();
      if (preview.kind === "payment" && preview.payment) {
        if (preview.payment.payer === rt.cfg.account) outgoing = BigInt(preview.payment.amount);
        for (const x of [preview.payment.payer, preview.payment.payee]) if (x !== rt.cfg.account) others.add(x);
      } else if (preview.bundle) {
        for (const leg of preview.bundle.terms.legs) {
          if (leg.payer === rt.cfg.account) outgoing += BigInt(leg.max_amount);
          for (const x of [leg.payer, leg.payee]) if (x !== rt.cfg.account) others.add(x);
        }
      } else throw new ToolError("the backend preview has neither a payment nor a bundle");
      if (preview.bundle && termsHash(preview.bundle.terms) !== (preview.bundle as { termsHash?: string }).termsHash) throw new ToolError("refused: the terms_hash of the backend does not match the bundle terms it sent; nothing was signed");
      for (const x of others) await rt.guards.counterparty(x);
      rt.guards.price(outgoing, "what the agent would pay by accepting");
      rt.guards.spend(outgoing, "accepting this offer");
      try {
        const signature = preview.kind === "bundle" && preview.bundle ? signBundle(preview.bundle.terms, rt.cfg.account, key).signature : undefined;
        const result = await post(`${base}/accept`, { account: rt.cfg.account, epoch: preview.epoch, ...(signature ? { signature } : {}) });
        return { kind: preview.kind, outgoing: outgoing.toString(), result, session: { spent: rt.guards.spent.toString(), remaining: rt.guards.remaining.toString() } };
      } catch (error) {
        throw keepIfUnknown(rt, outgoing, error);
      }
    },
  },
  {
    name: "x207_confirm_milestone",
    title: "Act on a milestone of an order",
    description:
      "Move a milestone of a service order: the buyer sends `confirmed` (commits the milestone amount, held to the price and session limits) or `disputed`; the seller sends `delivered` (with the deliverable hash) or `cancelled`. Read the order first with x207_order_status. Refused if the agent is neither buyer nor seller or the milestone does not exist. Moves no money by itself.",
    access: "write",
    inputSchema: {
      order_hash: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).describe("Hash of the order, from x207_order_status."), index: z.number().int().min(1).max(24).describe("Milestone number, counted from 1."),
      action: z.enum(["confirmed", "disputed", "delivered", "cancelled"]).describe("Buyer: confirmed or disputed. Seller: delivered or cancelled."), reason: z.string().min(1).max(200).optional().describe("Short reason, for disputed or cancelled."), deliverable_hash: HASH64.optional().describe("Hash of the delivered work; for delivered."),
    },
    handler: async (a, ctx) => {
      const rt = w(ctx);
      const key = needVoucher(rt, "x207_confirm_milestone");
      const post = needPost(rt, "x207_confirm_milestone");
      const get = needGet(ctx, "x207_confirm_milestone");
      const hash = a.order_hash as string;
      const order = (await get(`/orders/${hash}`)) as { buyer: string; seller: string; milestones: Array<{ index: number; amount: string; status: string }> };
      if (rt.cfg.account !== order.buyer && rt.cfg.account !== order.seller) throw new ToolError("refused: the agent is neither buyer nor seller of this order");
      await rt.guards.counterparty(rt.cfg.account === order.buyer ? order.seller : order.buyer);
      const milestone = order.milestones.find((m) => m.index === a.index);
      if (milestone === undefined) throw new ToolError(`order ${hash} has no milestone ${a.index}`);
      if (a.action === "delivered" && a.deliverable_hash === undefined) throw new ToolError("delivered needs deliverable_hash");
      if (a.action === "disputed" && a.reason === undefined) throw new ToolError("disputed needs a reason");
      const amount = a.action === "confirmed" ? BigInt(milestone.amount) : 0n;
      if (amount > 0n) {
        rt.guards.price(amount, `the milestone ${a.index}`);
        rt.guards.spend(amount, `confirming milestone ${a.index}`);
      }
      const notice = {
        circle: ctx.circleContract, order_hash: hash, milestone: a.index, actor: rt.cfg.account, action: a.action, at: Math.floor(rt.now() / 1000),
        deliverable_hash: a.action === "delivered" ? a.deliverable_hash : null, reason: a.action === "disputed" ? a.reason : null,
      };
      try {
        const result = await post(`/orders/${hash}/milestones/${a.index}`, { notice, signature: signNotice(ctx.circleContract, notice, key) });
        return { action: a.action, committed: amount.toString(), order: result, session: { spent: rt.guards.spent.toString(), remaining: rt.guards.remaining.toString() } };
      } catch (error) {
        throw keepIfUnknown(rt, amount, error);
      }
    },
  },
  {
    name: "x207_join",
    title: "Join the circle and stake",
    description:
      "Join the circle as the agent account: sends join (storage deposit 0.35 NEAR, not returned) and an ft_transfer_call of the USDT stake, signed with the NEAR key. Run it once, before any payment; check the result with x207_member_inspect. Off unless X207_ALLOW_OUTFLOWS=1 and X207_ALLOW_FULL_ACCESS_KEY=1; the stake counts against X207_MAX_SPEND_SESSION.",
    access: "write",
    inputSchema: { terms_hash: HASH64.describe("sha256 of the circle terms the agent accepts."), stake_amount: AMOUNT.describe("USDT to lock as stake, smallest unit (6 decimals).") },
    handler: async (a, ctx) => {
      const rt = w(ctx);
      rt.guards.outflows("x207_join");
      const voucherKey = needVoucher(rt, "x207_join");
      rt.guards.nearKey(await rt.keyKind(), "x207_join");
      const stake = BigInt(a.stake_amount as string);
      rt.guards.spend(stake, "the stake of x207_join");
      try {
        const circle = await circleRecord(ctx);
        const result = await onboardMember(
          { sendCall: rt.send, view: ctx.view },
          { circleContract: ctx.circleContract, circleId: ctx.circleId, accountId: rt.cfg.account, termsHash: a.terms_hash as string, stakeAmount: a.stake_amount as string, secretKey: voucherKey, usdtTokenId: circle.usdt_token_id },
        );
        return { account: rt.cfg.account, voucherPublicKey: result.publicKey, member: result.member, session: { spent: rt.guards.spent.toString(), remaining: rt.guards.remaining.toString() } };
      } catch (error) {
        throw keepIfUnknown(rt, stake, error);
      }
    },
  },
  {
    name: "x207_settle",
    title: "Pay the residual of an epoch",
    description:
      "Pay the cash the agent owes for one closed epoch, i.e. what is left after netting: an ft_transfer_call of USDT to the circle with the `settle` message. Pays at most the amount due; an epoch where the agent owes nothing is an error. Find the epoch with x207_epoch_report. Off unless X207_ALLOW_OUTFLOWS=1 and X207_ALLOW_FULL_ACCESS_KEY=1; the amount counts against X207_MAX_SPEND_SESSION.",
    access: "write",
    inputSchema: { epoch: EPOCH.describe("The closed epoch the agent owes for."), amount: AMOUNT.optional().describe("Pay this much, at most the amount due; the whole amount due when left out.") },
    handler: async (a, ctx) => {
      const rt = w(ctx);
      rt.guards.outflows("x207_settle");
      rt.guards.nearKey(await rt.keyKind(), "x207_settle");
      const position = (await ctx.view("net_position", { epoch: a.epoch, account_id: rt.cfg.account })) as ContractAbi.PositionView | null;
      if (position === null || position.role !== "debtor" || position.status !== "due") throw new ToolError(`the agent owes nothing for epoch ${a.epoch} (${position === null ? "no position" : `${position.role}, ${position.status}`})`);
      const due = BigInt(position.amount);
      const amount = a.amount === undefined ? due : BigInt(a.amount as string);
      if (amount > due) throw new ToolError(`refused: ${amount} is more than the ${due} due for epoch ${a.epoch}`);
      rt.guards.spend(amount, `settling epoch ${a.epoch}`);
      try {
        const circle = await circleRecord(ctx);
        const result = await rt.send(buildSettleTransferCall({ circleContract: ctx.circleContract, amount: amount.toString(), epoch: a.epoch as number, usdtTokenId: circle.usdt_token_id }));
        return { epoch: a.epoch, paid: amount.toString(), due: due.toString(), result: result ?? null, session: { spent: rt.guards.spent.toString(), remaining: rt.guards.remaining.toString() } };
      } catch (error) {
        throw keepIfUnknown(rt, amount, error);
      }
    },
  },
  {
    name: "x207_claim",
    title: "Claim a credit after clearing",
    description:
      "Claim the cash the agent is owed for one closed epoch after netting, to its own NEAR account (`near`) or its Intents balance (`intents`): sends claim with 1 yoctoNEAR. The destination is always the agent itself. Nothing claimable for the epoch is an error. Needs X207_ALLOW_FULL_ACCESS_KEY=1 because the call attaches a deposit.",
    access: "write",
    inputSchema: { epoch: EPOCH.describe("The closed epoch the agent is owed for."), destination: z.enum(["near", "intents"]).default("near").describe("near: the agent's NEAR account (default); intents: its Intents balance.") },
    handler: async (a, ctx) => {
      const rt = w(ctx);
      rt.guards.nearKey(await rt.keyKind(), "x207_claim");
      const position = (await ctx.view("net_position", { epoch: a.epoch, account_id: rt.cfg.account })) as ContractAbi.PositionView | null;
      if (position === null || position.role !== "creditor" || position.status !== "claimable") throw new ToolError(`nothing to claim for epoch ${a.epoch} (${position === null ? "no position" : `${position.role}, ${position.status}`})`);
      const result = await rt.send(buildClaimCall({ circleContract: ctx.circleContract, epoch: a.epoch as number, destination: a.destination as "near" | "intents" }));
      return { epoch: a.epoch, claimable: position.amount, destination: a.destination, result: result ?? null };
    },
  },
];

/** Which write tools this runtime may even list: a tool whose key or switch is missing is not offered (the guard would refuse it anyway). */
export function availableWriteTools(rt: WriteRuntime, hasBackend: boolean): ToolDef[] {
  const voucher = rt.cfg.voucherKey !== null;
  const near = rt.cfg.nearKey !== null && rt.cfg.allowFullAccessKey;
  const book = voucher && hasBackend;
  const ok: Record<string, boolean> = {
    x207_pay_request: voucher || (rt.cfg.evmKey ?? null) !== null, x207_list_offer: book, x207_make_offer: book, x207_accept_offer: book, x207_confirm_milestone: book,
    x207_join: voucher && near && rt.cfg.allowOutflows, x207_settle: near && rt.cfg.allowOutflows, x207_claim: near,
  };
  return WRITE_TOOLS.filter((t) => ok[t.name] === true);
}

/** Builds the runtime of the write tools from the configuration. The NEAR sender and the payment client are created on first use. */
export function createWriteRuntime(
  config: McpConfig, cfg: WriteConfig, view: CircleViewFn,
  deps: { post: BackendPost | null; send?: (call: ContractCall) => Promise<unknown>; now?: () => number; resolve?: HostResolver } = { post: null },
): WriteRuntime {
  const now = deps.now ?? Date.now;
  const fetchFn = config.fetch ?? fetch;
  // M-2: the paid request connects only to the addresses that the guard checked (one lookup, pinned); X207_ALLOW_PRIVATE_URLS=1 and an injected fetch (tests) keep the plain fetch
  const payBase = config.fetch === undefined && !cfg.allowPrivateUrls ? createPinnedFetch(deps.resolve ?? defaultResolver) : fetchFn;
  let sender = deps.send;
  let kind: NearKeyKind | undefined;
  let pay: typeof fetch | undefined;
  const guards = new Guards(cfg, view);
  return {
    cfg, guards, post: deps.post, now, resolve: deps.resolve ?? defaultResolver,
    send: async (call) => {
      if (sender === undefined) {
        const { createNearSender } = await import("@x207/core/signer");
        sender = createNearSender({ rpcUrl: config.rpcUrls[0] as string, accountId: cfg.account, secretKey: cfg.nearKey as `ed25519:${string}` });
      }
      return sender(call);
    },
    keyKind: async () => {
      if (kind !== undefined) return kind;
      if (cfg.nearKey === null) return (kind = "none");
      kind = await accessKeyKind(config.rpcUrls, cfg.account, voucherPublicKey(cfg.nearKey), fetchFn);
      return kind;
    },
    payFetch: () => {
      if (pay === undefined) {
        const client = new X207PaymentClient({ payer: cfg.account, ...(cfg.evmKey ? { signer: evmSignerFromPrivateKey(cfg.evmKey) } : { secretKey: cfg.voucherKey as `ed25519:${string}` }), headroom: headroomFromRpc({ rpcUrls: config.rpcUrls, fetch: fetchFn }) });
        client.onBeforePaymentCreation(async ({ selectedRequirements }) => {
          try {
            if (!String(selectedRequirements.network).startsWith("x207:")) throw new ToolError("refused: the payment request is not an x207 payment");
            const amount = BigInt(selectedRequirements.amount);
            await guards.counterparty(selectedRequirements.payTo);
            guards.price(amount, "the price of the request");
            guards.spend(amount, "this payment");
          } catch (error) {
            return { abort: true as const, reason: (error as Error).message };
          }
        });
        pay = wrapFetchWithPayment(payBase, client);
      }
      return pay;
    },
  };
}

/** `view_access_key` of the NEAR key on the agent account. `unknown` when the key is not on the account or the RPC cannot say. */
export async function accessKeyKind(rpcUrls: readonly string[], account: string, publicKey: string, fetchFn: typeof fetch): Promise<NearKeyKind> {
  for (const url of rpcUrls) {
    try {
      const response = await fetchFn(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "x207", method: "query", params: { request_type: "view_access_key", finality: "optimistic", account_id: account, public_key: publicKey } }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json()) as { result?: { permission?: unknown; error?: string }; error?: unknown };
      const permission = body.result?.permission;
      if (permission === "FullAccess") return "full-access";
      if (permission !== undefined && typeof permission === "object" && permission !== null && "FunctionCall" in permission) return "function-call";
      if (body.result?.error !== undefined || body.error !== undefined) return "unknown";
    } catch {
      // try the next endpoint
    }
  }
  return "unknown";
}
