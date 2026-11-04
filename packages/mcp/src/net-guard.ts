// The network guard of x207_pay_request (security review batch 8, SD-082 fix). The URL comes from a model, so it can come from a prompt injection: without a guard the tool would fetch
// http://169.254.169.254/ (the credentials of a cloud machine), http://127.0.0.1:<port>/ (a service on this machine) or an address of the office network, and hand the answer back to the model.
// A URL is refused when its host is, or resolves to, a loopback, private, link-local, carrier-grade NAT, multicast or unspecified address, or when it is a name like `localhost` or `*.internal`.
// X207_ALLOW_PRIVATE_URLS=1 turns the guard off, for a seller on this machine (the demos and the sandbox tests do that).
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

export type HostResolver = (host: string) => Promise<string[]>;

export const defaultResolver: HostResolver = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

const NAMES = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/** The 16 bytes of a literal IPv6 address (`::` forms, an IPv4 tail); `null` when it is not one. */
export function ipv6Bytes(address: string): number[] | null {
  let text = address.toLowerCase();
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const q = tail.slice(1).map(Number);
    if (q.some((x) => x > 255)) return null;
    text = text.slice(0, tail.index) + (((q[0] as number) << 8) | (q[1] as number)).toString(16) + ":" + (((q[2] as number) << 8) | (q[3] as number)).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const head = groups(halves[0] as string);
  const rest = halves.length === 2 ? groups(halves[1] as string) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const out: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    out.push(v >> 8, v & 255);
  }
  return out.length === 16 ? out : null;
}

/** `true` when `address` (a literal IPv4 or IPv6) is not a public unicast address. */
export function isPrivateAddress(address: string): boolean {
  const a = address.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(a);
  if (family === 4) {
    const [p, q] = a.split(".").map(Number) as [number, number];
    return p === 0 || p === 10 || p === 127 || (p === 100 && q >= 64 && q <= 127) || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 192 && q === 0) || (p === 198 && (q === 18 || q === 19)) || p >= 224;
  }
  if (family === 6) {
    const bytes = ipv6Bytes(a);
    if (bytes === null) return true;
    const v4 = (i: number): string => `${bytes[i]}.${bytes[i + 1]}.${bytes[i + 2]}.${bytes[i + 3]}`;
    const zeros = (from: number, to: number): boolean => bytes.slice(from, to).every((x) => x === 0);
    // forms that CARRY an IPv4 address: the carried address decides (cross review UM-112, F1; `new URL` writes them in hex, `::ffff:7f00:1`, `64:ff9b::a9fe:a9fe`)
    if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return isPrivateAddress(v4(12)); // ::ffff:0:0/96 IPv4-mapped
    if (zeros(0, 12)) return bytes[12] === 0 && bytes[13] === 0 && bytes[14] === 0 && (bytes[15] as number) <= 1 ? true : isPrivateAddress(v4(12)); // ::/96 IPv4-compatible, :: and ::1
    if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) { // 64:ff9b::/96 NAT64, and 64:ff9b:1::/48 (local use, refused whole)
      if (zeros(4, 12)) return isPrivateAddress(v4(12));
      if (bytes[4] === 0 && bytes[5] === 1) return true;
    }
    if (zeros(0, 8) && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0) return isPrivateAddress(v4(12)); // ::ffff:0:0:0/96 IPv4-translated (SIIT)
    if (bytes[0] === 0x20 && bytes[1] === 0x02) return isPrivateAddress(v4(2)); // 2002::/16 6to4
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0) return true; // 2001::/32 Teredo: the server and the client are inside the address
    const b0 = bytes[0] as number;
    const b1 = bytes[1] as number;
    if ((b0 & 0xfe) === 0xfc) return true; // fc00::/7 unique local
    if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true; // fe80::/10 link-local
    if (b0 === 0xfe && (b1 & 0xc0) === 0xc0) return true; // fec0::/10 site-local (deprecated)
    if (bytes[0] === 0xff) return true; // ff00::/8 multicast
    if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true; // 2001:db8::/32 documentation
    return false;
  }
  return true; // not an address at all
}

/** Throws a message for the model when the URL points at a place that a paid request should not reach. */
export async function assertPublicUrl(url: URL, resolve: HostResolver = defaultResolver): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.+$/, ""); // `localhost.` is `localhost` (cross review UM-112, F6)
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

/**
 * M-2 (cross review UM-112): DNS rebinding. `assertPublicUrl` resolves the name to check it, and `fetch` resolves it again to connect, so a name that answers a public address to the first
 * question and 169.254.169.254 to the second walks around the check. This fetch connects through its own `lookup`: the name is resolved ONCE, every address is checked, and the connection
 * goes to one of the addresses that were checked (the TLS name stays the host of the URL). No redirect is followed (the caller sees the 3xx), and the body is read as a stream.
 */
export function createPinnedFetch(resolve: HostResolver = defaultResolver): typeof fetch {
  const lookupChecked = (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void): void => {
    resolve(hostname.replace(/\.+$/, "")).then(
      (addresses) => {
        const bad = addresses.find((a) => isPrivateAddress(a));
        if (addresses.length === 0 || bad !== undefined) return callback(new Error(`refused: ${hostname} resolves to ${bad ?? "no address"}, a private, loopback or link-local address`));
        const list = addresses.map((address) => ({ address, family: isIP(address) }));
        return options.all === true ? callback(null, list) : callback(null, list[0]!.address, list[0]!.family);
      },
      (error: Error) => callback(error),
    );
  };
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("only http and https");
    if (init?.redirect !== undefined && init.redirect !== "manual" && req.redirect !== "manual") throw new Error("a redirect is not followed by this fetch");
    const body = req.body === null ? null : Buffer.from(await req.arrayBuffer());
    const headers: Record<string, string> = {};
    req.headers.forEach((value, name) => {
      headers[name] = value;
    });
    if (body !== null) headers["content-length"] = String(body.length);
    return new Promise<Response>((resolveResponse, reject) => {
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const out = send(url, { method: req.method, headers, lookup: lookupChecked as never, signal: req.signal }, (res) => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) for (const v of Array.isArray(value) ? value : value === undefined ? [] : [value]) responseHeaders.append(name, v);
        const status = res.statusCode ?? 502;
        resolveResponse(new Response(status === 204 || status === 304 ? null : (Readable.toWeb(res) as unknown as ReadableStream), { status, statusText: res.statusMessage ?? "", headers: responseHeaders }));
      });
      out.on("error", reject);
      out.end(body ?? undefined);
    });
  }) as typeof fetch;
}
