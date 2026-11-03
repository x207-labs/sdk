// The canonical hashes of a clearing proposal and of the positions of an epoch (SD-080, interface 0.0.13, CT-099). The contract computes the same bytes in `events.rs`; the golden
// vector is `contracts/tests/vectors/clearing_hashes.json` (a copy is in `spec/test-vectors/clearing-hashes/`).
//   edges_hash     = sha256( compact JSON array of the edges with `cleared` > 0, sorted by (debtor, creditor) as byte strings, each edge {"debtor","creditor","cleared"} )
//   positions_hash = sha256( compact JSON array of all positions sorted by account_id as byte strings, each {"account_id","net","role","status","amount","outstanding_debt"} )
// Compact JSON: no spaces, the keys in the order above, UTF-8, amounts as decimal strings, an empty list is `[]`. This module needs no node:crypto, so it runs in the browser.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { ClearingAppliedEdge, EpochCommittedPosition } from "./events.js";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Order of two strings as byte strings (UTF-8), the order of the contract. */
function byteCompare(a: string, b: string): number {
  const x = utf8(a);
  const y = utf8(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

/** An amount as a decimal string without sign or leading zeros; a value that is not a whole number is refused. */
function amount(value: string, name: string, signed = false): string {
  if (!(signed ? /^-?(0|[1-9]\d*)$/ : /^(0|[1-9]\d*)$/).test(value)) throw new Error(`${name} must be a decimal whole number string, got ${JSON.stringify(value)}`);
  return value === "-0" ? "0" : value;
}

/** The canonical JSON of the edges of a clearing proposal: only `cleared` > 0, sorted by (debtor, creditor). */
export function edgesCanonical(edges: readonly ClearingAppliedEdge[]): string {
  const kept = edges.filter((e) => BigInt(amount(e.cleared, "cleared")) > 0n).sort((a, b) => byteCompare(a.debtor, b.debtor) || byteCompare(a.creditor, b.creditor));
  return JSON.stringify(kept.map((e) => ({ debtor: e.debtor, creditor: e.creditor, cleared: amount(e.cleared, "cleared") })));
}

/** The canonical JSON of the positions of an epoch, sorted by `account_id`. */
export function positionsCanonical(positions: readonly EpochCommittedPosition[]): string {
  const ordered = [...positions].sort((a, b) => byteCompare(a.account_id, b.account_id));
  return JSON.stringify(
    ordered.map((p) => ({
      account_id: p.account_id, net: amount(p.net, "net", true), role: p.role, status: p.status, amount: amount(p.amount, "amount"), outstanding_debt: amount(p.outstanding_debt, "outstanding_debt"),
    })),
  );
}

/** `edges_hash` of the event `clearing_applied` (hex, 64 characters). */
export const edgesHash = (edges: readonly ClearingAppliedEdge[]): string => bytesToHex(sha256(utf8(edgesCanonical(edges))));
/** `positions_hash` of the event `epoch_committed` (hex, 64 characters). */
export const positionsHash = (positions: readonly EpochCommittedPosition[]): string => bytesToHex(sha256(utf8(positionsCanonical(positions))));
