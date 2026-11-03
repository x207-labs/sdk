import { describe, expect, it } from "vitest";
import {
  ASSET_KINDS, AssetTemplateError, buildAssetTemplate, checkRwaWhitelist, formatTokenAmount, type AssetInput, type AssetTemplateErrorCode,
} from "../src/index.js";

const NOW = 1_800_000_000;
const DAY = 86_400;
const base = { unitPrice: "10000000", expiresAt: NOW + 7 * DAY };
const nft = { nftContract: "nft.near", tokenId: "t1" };
const ft = { ftContract: "token.near", amount: "2500000", decimals: 6, symbol: "TKN" };
const mt = { mtContract: "intents.near", tokenId: "nep141:usdt.tether-token.near", amount: "750000" };

/** One valid input of each of the ten kinds of batch 1. */
const VALID: Record<string, AssetInput> = {
  nft: { kind: "nft", name: "Render license", ...nft, ...base },
  ticket: { kind: "ticket", event: { name: "NEAR Conf", startsAt: NOW + 10 * DAY, endsAt: NOW + 11 * DAY }, ...nft, ...base },
  "game-item": { kind: "game-item", game: { name: "Dungeons", collection: "swords" }, ...nft, ...base },
  coupon: { kind: "coupon", description: "20 percent off", validUntil: NOW + 30 * DAY, ...nft, ...base },
  license: { kind: "license", product: "Editor Pro", termsHash: "ab".repeat(32), seats: 3, ...nft, ...base },
  ft: { kind: "ft", ...ft, ...base },
  rwa: { kind: "rwa", whitelist: { circleContract: true, grantor: true, buyer: true }, ...ft, ...base },
  lst: { kind: "lst", rate: { nearPerToken: "1.0532", source: "pool dashboard", asOf: NOW - 60 }, ...ft, ...base },
  "intents-balance": { kind: "intents-balance", label: "USDT at Intents", ...mt, ...base },
  "pool-share": { kind: "pool-share", pool: "NEAR-USDT", valueInfo: "about 12 USDT", standard: "nep245", ...mt, ...base },
};

const code = (input: AssetInput, now = NOW): string | undefined => {
  try {
    buildAssetTemplate(input, now);
    return undefined;
  } catch (error) {
    return error instanceof AssetTemplateError ? error.code : `other: ${String(error)}`;
  }
};

describe("SD-061 templates of batch 1 (catalog 1 to 10)", () => {
  it("TC-SD-061-01 each of the ten kinds builds a class A grant input with the scope the contract reads, and the catalog names", () => {
    expect(Object.keys(VALID).sort()).toEqual([...ASSET_KINDS].sort());
    const expectedType: Record<string, string> = {
      nft: "nft:nep171", ticket: "ticket:event-nft", "game-item": "game:item-nft", coupon: "coupon:voucher-nft", license: "license:software-nft", ft: "token:nep141",
      rwa: "rwa:tokenized", lst: "lst:liquid-staking", "intents-balance": "intents:multi-token", "pool-share": "amm:lp-share",
    };
    for (const [kind, input] of Object.entries(VALID)) {
      const t = buildAssetTemplate(input, NOW);
      expect(t.assetType, kind).toBe(expectedType[kind]);
      expect(t.assetClass).toBe("A");
      expect(t.grantInput).toMatchObject({ asset_type: expectedType[kind], delivery_method: t.deliveryMethod, unit: "once", unit_price: "10000000", operator: null });
      expect(t.grantInput.limits).toEqual({ scope: t.scope, quota: null, expires_at: String(BigInt(base.expiresAt) * 1_000_000_000n) });
      expect(t.side).toEqual({ asset_type: expectedType[kind], asset_class: "A", quantity: 1, value: "10000000" });
      expect(t.detail.length).toBeLessThanOrEqual(2048);
      expect(t.detail).toMatch(/^[\x20-\x7e]+$/);
      expect(JSON.parse(t.detail).kind).toBe(kind);
      expect(t.warnings.length).toBeGreaterThan(0);
    }
  });

  it("TC-SD-061-02 scopes: NFT {nft_contract, token_id}, token {ft_contract, amount}, multi-token {mt_contract, token_id, amount}; delivery method by escrow", () => {
    expect(JSON.parse(buildAssetTemplate(VALID.nft!, NOW).scope)).toEqual({ nft_contract: "nft.near", token_id: "t1" });
    expect(JSON.parse(buildAssetTemplate(VALID.rwa!, NOW).scope)).toEqual({ ft_contract: "token.near", amount: "2500000" });
    expect(JSON.parse(buildAssetTemplate(VALID["intents-balance"]!, NOW).scope)).toEqual({ mt_contract: "intents.near", token_id: "nep141:usdt.tether-token.near", amount: "750000" });
    const methods = Object.fromEntries(Object.entries(VALID).map(([k, i]) => [k, buildAssetTemplate(i, NOW).deliveryMethod]));
    expect(methods).toEqual({
      nft: "escrow_nft", ticket: "escrow_nft", "game-item": "escrow_nft", coupon: "escrow_nft", license: "escrow_nft",
      ft: "escrow_ft", rwa: "escrow_ft", lst: "escrow_ft", "intents-balance": "escrow_mt", "pool-share": "escrow_mt",
    });
    // a pool share held as a NEP-141 token goes the token way
    const fungible = buildAssetTemplate({ kind: "pool-share", pool: "P", standard: "nep141", ...ft, ...base }, NOW);
    expect(fungible.deliveryMethod).toBe("escrow_ft");
    expect(JSON.parse(fungible.scope)).toEqual({ ft_contract: "token.near", amount: "2500000" });
  });

  it("TC-SD-061-03 the deposit call of each template is the call the contract expects", () => {
    expect(buildAssetTemplate(VALID.ticket!, NOW).deposit("circle.near", 5)).toEqual({
      receiverId: "nft.near", methodName: "nft_transfer_call", args: { receiver_id: "circle.near", token_id: "t1", msg: '{"grant_id":5}' }, deposit: 1n,
    });
    expect(buildAssetTemplate(VALID.ft!, NOW).deposit("circle.near", 6)).toMatchObject({
      receiverId: "token.near", methodName: "ft_transfer_call", args: { receiver_id: "circle.near", amount: "2500000", msg: '{"action":"escrow","grant_id":6}' },
    });
    expect(buildAssetTemplate(VALID["intents-balance"]!, NOW).deposit("circle.near", 7)).toMatchObject({
      receiverId: "intents.near", methodName: "mt_transfer_call", args: { receiver_id: "circle.near", token_id: "nep141:usdt.tether-token.near", amount: "750000", msg: '{"action":"escrow","grant_id":7}' },
    });
  });

  it("TC-SD-061-04 one invalid listing per group is refused with a stable code: NFT group", () => {
    const ticket = VALID.ticket as Extract<AssetInput, { kind: "ticket" }>;
    const coupon = VALID.coupon as Extract<AssetInput, { kind: "coupon" }>;
    const license = VALID.license as Extract<AssetInput, { kind: "license" }>;
    const cases: Array<[string, AssetInput, AssetTemplateErrorCode]> = [
      ["ticket for an event that is over", { ...ticket, event: { ...ticket.event, startsAt: NOW - 2 * DAY, endsAt: NOW - DAY } }, "ticket_event_over"],
      ["ticket offered past the event", { ...ticket, expiresAt: ticket.event.endsAt + 1 }, "ticket_offer_after_event"],
      ["expired coupon", { ...coupon, validUntil: NOW - 1 }, "coupon_expired"],
      ["coupon offered past its validity", { ...coupon, expiresAt: coupon.validUntil + 1 }, "coupon_offer_after_validity"],
      ["license without a terms hash", { ...license, termsHash: "AB".repeat(32) }, "license_terms_hash"],
      ["license with no seat", { ...license, seats: 0 }, "license_seats"],
      ["NFT with a bad contract", { kind: "nft", nftContract: "Not An Account", tokenId: "t1", ...base }, "bad_account"],
      ["NFT with no token", { kind: "nft", nftContract: "nft.near", tokenId: "", ...base }, "bad_token_id"],
      ["offer that is already over", { kind: "nft", ...nft, ...base, expiresAt: NOW - 1 }, "bad_expiry"],
    ];
    for (const [name, input, expected] of cases) {
      expect(code(input), name).toBe(expected);
    }
  });

  it("TC-SD-061-05 tokens: amount in token units, decimals, whitelist of an RWA token, the information of an LST", async () => {
    expect(formatTokenAmount("2500000", 6)).toBe("2.5");
    expect(formatTokenAmount("5", 6)).toBe("0.000005");
    expect(formatTokenAmount("1000", 0)).toBe("1000");
    // every kind with a time limit has the same key `valid_until`: the end of the event for a ticket, the validity of a coupon
    const ticketMeta = JSON.parse(buildAssetTemplate(VALID.ticket!, NOW).detail);
    expect(ticketMeta.valid_until).toBe(ticketMeta.event.ends_at);
    expect(JSON.parse(buildAssetTemplate(VALID.coupon!, NOW).detail).valid_until).toBe(NOW + 30 * DAY);
    expect(buildAssetTemplate(VALID.ft!, NOW).detail).toContain('"display":"2.5 TKN"');
    const cases: Array<[string, AssetInput, AssetTemplateErrorCode]> = [
      ["amount 0", { kind: "ft", ...ft, amount: "0", ...base }, "bad_amount"],
      ["amount with a decimal point", { kind: "ft", ...ft, amount: "1.5", ...base }, "bad_amount"],
      ["amount over u128", { kind: "ft", ...ft, amount: "340282366920938463463374607431768211456", ...base }, "bad_amount"],
      ["decimals 40", { kind: "ft", ...ft, decimals: 40, ...base }, "bad_decimals"],
      ["RWA where the circle is not whitelisted", { kind: "rwa", ...ft, whitelist: { circleContract: false, grantor: true }, ...base }, "rwa_not_whitelisted"],
      ["RWA where the grantor is not whitelisted", { kind: "rwa", ...ft, whitelist: { circleContract: true, grantor: false }, ...base }, "rwa_not_whitelisted"],
      ["LST with a rate that is not a number", { kind: "lst", ...ft, rate: { nearPerToken: "a lot", source: "s", asOf: NOW }, ...base }, "bad_amount"],
    ];
    for (const [name, input, expected] of cases) expect(code(input), name).toBe(expected);
    // an RWA token without a whitelist check is allowed with a warning, a failed buyer check is a warning too
    expect(buildAssetTemplate({ kind: "rwa", ...ft, ...base }, NOW).warnings.join(" ")).toContain("Whitelist token belum diperiksa");
    expect(buildAssetTemplate({ kind: "rwa", ...ft, whitelist: { circleContract: true, grantor: true, buyer: false }, ...base }, NOW).warnings.join(" ")).toContain("Pembeli belum ada di whitelist");
    expect(buildAssetTemplate(VALID.lst!, NOW).warnings.join(" ")).toContain("bukan oracle");
    expect(buildAssetTemplate(VALID.ft!, NOW).warnings.join(" ")).toContain("biaya transfer tidak didukung");
    // the check itself
    const whitelisted = new Set(["circle.near", "grantor.near"]);
    const check = async (_token: string, who: string) => whitelisted.has(who);
    expect(await checkRwaWhitelist(check, "token.near", ["circle.near", "grantor.near", "buyer.near"])).toEqual(["buyer.near"]);
    expect(await checkRwaWhitelist(check, "token.near", ["circle.near", "grantor.near"])).toEqual([]);
  });

  it("TC-SD-061-06 multi-tokens: the token id of an Intents balance starts with nep141: or nep245:, a pool share is nep141 or nep245", () => {
    const intents = VALID["intents-balance"] as Extract<AssetInput, { kind: "intents-balance" }>;
    expect(code({ ...intents, tokenId: "usdt" })).toBe("intents_token_id");
    expect(code({ ...intents, tokenId: "nep245:pool.near:1" })).toBeUndefined();
    expect(code({ ...intents, amount: "0" })).toBe("bad_amount");
    expect(code({ kind: "pool-share", pool: "P", standard: "erc20" as never, ...mt, ...base })).toBe("pool_standard");
    expect(code({ kind: "pool-share", pool: "P", standard: "nep245", ...mt, tokenId: "", ...base })).toBe("bad_token_id");
    expect(buildAssetTemplate(intents, NOW).warnings.join(" ")).toContain("kontrak Intents yang asli");
  });

  it("TC-SD-061-07 no secret in a listing, ASCII only, detail within 2048, and an unknown kind is refused", () => {
    expect(code({ kind: "nft", name: "x".repeat(81), ...nft, ...base })).toBe("bad_text");
    expect(code({ kind: "nft", name: "café", ...nft, ...base })).toBe("bad_text");
    expect(code({ kind: "pool-share", pool: "P", valueInfo: "y".repeat(121), standard: "nep245", ...mt, ...base })).toBe("bad_text");
    expect(code({ kind: "nft", ...nft, ...base, unitPrice: "0" })).toBe("bad_price");
    expect(code({ kind: "stock" as never, ...nft, ...base })).toBe("bad_kind");
    // the metadata never carries a field called code or secret
    for (const input of Object.values(VALID)) expect(buildAssetTemplate(input, NOW).detail).not.toMatch(/"(code|secret|password|api_?key)":/i);
  });
});
