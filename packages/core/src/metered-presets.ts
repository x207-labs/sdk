// Jenis, satuan, dan preset sumber daya terukur P5 (SD-064): data murni tanpa jaringan, dipakai server (`createMeteredEndpoint`) dan formulir listing (FE-024).
// `asset_type` dan nomor katalog sama dengan katalog barter (`scripts/lib/asset-catalog.mjs`) dan backend (BE-050). Satuan hidup di SDK, listing, dan voucher; kontrak tidak berubah.

/** Satuan yang dikenal listing sumber daya (BE-050); sama dengan `RESOURCE_UNITS` di backend. */
export const METERED_UNITS = ["call", "minute", "day", "GB", "job", "request"] as const;
export type MeteredUnit = (typeof METERED_UNITS)[number];

/** Dua belas jenis P5 dengan nomor katalog: #31 CPU, #32 GPU, #33 penyimpanan, #34 cache dan CDN, #35 inferensi, #36 fine-tuning, #44 umpan data, #45 sensor IoT, #47 relayer gas, #49 antrean, #55 proxy, #90 perangkat rumahan. */
export const METERED_KINDS = [
  "cpu", "gpu", "storage", "cdn", "inference", "fine-tuning", "data-feed", "iot-sensor", "gas-relayer", "priority-slot", "proxy-bandwidth", "home-device",
] as const;
export type MeteredKind = (typeof METERED_KINDS)[number];

export type MeteredPreset = {
  assetType: string;
  catalogNo: number;
  /** Satuan bawaan, lalu satuan lain yang masuk akal untuk jenis ini. */
  units: readonly [MeteredUnit, ...MeteredUnit[]];
  warnings: readonly string[];
};

const RISK = "The provider may deliver a bad result or not answer; the buyer loses at most one unit per event because payment is per use.";
const JOB = "A long job is paid in steps with a cumulative voucher (MeteredJob) so each party's risk is at most one piece.";

export const METERED_PRESETS: Readonly<Record<MeteredKind, MeteredPreset>> = {
  cpu: { assetType: "compute:cpu-idle", catalogNo: 31, units: ["minute", "job"], warnings: [RISK, JOB] },
  gpu: { assetType: "compute:gpu-hours", catalogNo: 32, units: ["minute", "job"], warnings: [RISK, JOB] },
  storage: { assetType: "storage:capacity", catalogNo: 33, units: ["GB", "day"], warnings: [RISK, "Storage is not guaranteed to stay available or to avoid loss; keep another copy of important data."] },
  cdn: { assetType: "cdn:static-cache", catalogNo: 34, units: ["GB", "request"], warnings: [RISK] },
  inference: { assetType: "model:inference", catalogNo: 35, units: ["request", "call"], warnings: [RISK, "Model output is not guaranteed to be correct; random tests and reputation judge the provider, not the protocol."] },
  "fine-tuning": { assetType: "model:fine-tuning", catalogNo: 36, units: ["job"], warnings: [RISK, JOB, "Training data sent to the provider can be read by the provider; do not send secret data or personal data of third parties."] },
  "data-feed": { assetType: "oracle:data-feed", catalogNo: 44, units: ["call", "request"], warnings: [RISK, "The data feed value is not verified by the protocol."] },
  "iot-sensor": { assetType: "iot:sensor-data", catalogNo: 45, units: ["call", "day"], warnings: [RISK, "Sensor data must not contain personal data of third parties."] },
  "gas-relayer": { assetType: "gas:relayer", catalogNo: 47, units: ["request", "call"], warnings: [RISK] },
  "priority-slot": { assetType: "queue:priority-slot", catalogNo: 49, units: ["request", "day"], warnings: [RISK] },
  "proxy-bandwidth": { assetType: "network:proxy-bandwidth", catalogNo: 55, units: ["GB", "request"], warnings: [RISK, "Proxy and bandwidth are subject to local law; the provider and the buyer are responsible for the traffic that passes."] },
  "home-device": { assetType: "compute:home-device", catalogNo: 90, units: ["minute", "day", "job"], warnings: [RISK, "Electricity, network security, and hardware are borne by the owner."] },
};

/** Batas atas per request bila pemanggil tidak menyebutnya: cukup untuk satu pemakaian wajar, dan menolak tagihan raksasa sebelum 402. */
export const DEFAULT_MAX_QUANTITY: Readonly<Record<MeteredUnit, number>> = { call: 1000, request: 1000, minute: 1440, day: 31, GB: 1000, job: 1 };


const SECRET_PARAM = /^(api[-_]?key|key|token|access[-_]?token|secret|password|passwd|pwd|auth|authorization|signature|sig|credential|session)$/i;

const MAX_URL = 512;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
/** Layanan yang namanya menjawab dengan alamat yang tertulis di nama: cara memberi alamat privat nama yang tampak publik. */
export const WILDCARD_DNS: readonly string[] = ["nip.io", "sslip.io", "xip.io", "localtest.me", "lvh.me", "traefik.me", "localhost.run", "vcap.me", "lacolhost.com"];

/**
 * Alasan nama host ditolak sebagai tujuan, atau `null` bila tampak publik (tinjauan BE-062, F6): satu titik di ujung nama dibuang sebelum pemeriksaan (`localhost.` sama dengan `localhost`),
 * alamat IP, `localhost`, `.local`, `.internal`, nama tanpa titik, nama yang membawa alamat IP (`127.0.0.1.nip.io`) dan layanan DNS wildcard ditolak. Ini pemeriksaan teks: yang menyambung
 * harus tetap me-resolve nama dan menolak alamat non-publik saat tersambung.
 */
export function publicHostProblem(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("[") || IPV4.test(host)) return "endpoint must use a host name, not an IP address";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) return "endpoint must be a public host name";
  if (/(^|\.)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(\.|$)/.test(host) || WILDCARD_DNS.some((d) => host === d || host.endsWith(`.${d}`))) return "endpoint must not use a name that carries an IP address or wildcard DNS";
  return null;
}

/** Alasan endpoint ditolak sebagai alamat listing sumber daya, atau `null` bila https tanpa kredensial. Aturan yang sama dengan backend (BE-050, `endpointProblem`). */
export function endpointProblem(endpoint: unknown): string | null {
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > MAX_URL) return `endpoint must be text of 1 to ${MAX_URL} characters`;
  if (!/^[\x21-\x7e]+$/.test(endpoint)) return "endpoint must be ASCII without spaces";
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return "endpoint is not a URL";
  }
  if (url.protocol !== "https:") return "endpoint must be https";
  if (url.username !== "" || url.password !== "") return "endpoint must not contain a user name or password";
  if (url.hash !== "") return "endpoint must not contain a fragment";
  const hostProblem = publicHostProblem(url.hostname);
  if (hostProblem !== null) return hostProblem;
  for (const name of url.searchParams.keys()) if (SECRET_PARAM.test(name)) return `endpoint must not contain credentials in the query (${name})`;
  return null;
}

/** `Listing.detail` sumber daya (BE-050): `{"kind","unit","unit_price","endpoint"}`. Melempar `Error` bila endpoint tidak sah. */
export function resourceListingDetail(input: { kind: MeteredKind; unit: MeteredUnit; unitPriceAtomic: string; endpoint: string }): string {
  const problem = endpointProblem(input.endpoint);
  if (problem !== null) throw new Error(problem);
  return JSON.stringify({ kind: input.kind, unit: input.unit, unit_price: input.unitPriceAtomic, endpoint: input.endpoint });
}

/** Perkiraan biaya: harga satuan (satuan credit terkecil) × jumlah satuan (angka desimal, paling banyak 6 desimal), dibulatkan ke atas; `null` bila masukan tidak sah. */
export function estimateMeteredAmount(unitPriceAtomic: string, quantity: string): string | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(quantity.trim());
  if (!match || !/^[1-9]\d*$/.test(unitPriceAtomic)) return null;
  const micro = BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
  if (micro === 0n) return null;
  return ((BigInt(unitPriceAtomic) * micro + 999_999n) / 1_000_000n).toString();
}
