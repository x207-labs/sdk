// The network guard of x207_pay_request (security review batch 8, SD-082 fix). The URL comes from a model, so it can come from a prompt injection: without a guard the tool would fetch
// http://169.254.169.254/ (the credentials of a cloud machine), http://127.0.0.1:<port>/ (a service on this machine) or an address of the office network, and hand the answer back to the model.
// A URL is refused when its host is, or resolves to, a loopback, private, link-local, carrier-grade NAT, multicast or unspecified address, or when it is a name like `localhost` or `*.internal`.
// X207_ALLOW_PRIVATE_URLS=1 turns the guard off, for a seller on this machine (the demos and the sandbox tests do that).
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type HostResolver = (host: string) => Promise<string[]>;

export const defaultResolver: HostResolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

const NAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/** `true` when `address` (a literal IPv4 or IPv6) is not a public unicast address. */
export function isPrivateAddress(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(a);
  if (family === 4) {
    const [p, q] = a.split(".").map(Number) as [number, number];
    return p === 0 || p === 10 || p === 127 || (p === 100 && q >= 64 && q <= 127) || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 192 && q === 0) || (p === 198 && (q === 18 || q === 19)) || p >= 224;
  }
  if (family === 6) {
    if (a === "::" || a === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPrivateAddress(mapped[1] as string);
    const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1] as string, 16);
      const lo = parseInt(mappedHex[2] as string, 16);
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a) || a.startsWith("2001:db8");
  }
  return true; // not an address at all
}

/** Throws a message for the model when the URL points at a place that a paid request should not reach. */
export async function assertPublicUrl(url: URL, resolve: HostResolver = defaultResolver): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "") throw new Error("the URL has no host");
  if (NAMES.test(host)) throw new Error(`refused: ${host} is a name of this machine or of a private network; set X207_ALLOW_PRIVATE_URLS=1 only for a seller you run yourself`);
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) throw new Error(`refused: ${host} is a private, loopback or link-local address; set X207_ALLOW_PRIVATE_URLS=1 only for a seller you run yourself`);
    return;
  }
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (error) {
    throw new Error(`refused: ${host} could not be resolved (${(error as Error).message})`);
  }
  if (addresses.length === 0) throw new Error(`refused: ${host} has no address`);
  for (const address of addresses) {
    if (isPrivateAddress(address)) throw new Error(`refused: ${host} resolves to ${address}, a private, loopback or link-local address; set X207_ALLOW_PRIVATE_URLS=1 only for a seller you run yourself`);
  }
}

/** Reads a response body up to `limit` bytes and stops there: a seller that streams for ever cannot fill the memory of the server. */
export async function readCapped(response: Response, limit: number): Promise<{ text: string; cut: boolean }> {
  if (response.body === null) return { text: "", cut: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.length > limit) {
      chunks.push(value.subarray(0, limit - size));
      size = limit;
      cut = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.length;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), cut };
}
