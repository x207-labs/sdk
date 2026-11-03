// Template endpoint terukur (SD-064, pipeline P5, kelas D). Satu baris konfigurasi per jenis sumber daya: `createMeteredEndpoint({ kind, unitPrice, handler })` memberi rute
// `x207Middleware` dengan harga per satuan (SD-062), batas atas per request, `detail` listing (BE-050), dan peringatan jenisnya. Preset dua belas jenis mengikuti katalog barter
// (`asset_type` D10 dan nomor katalog); satuan hidup di SDK, listing, dan voucher, kontrak tidak berubah. Job panjang memakai `MeteredJob` (SD-063).
import { x207Middleware, type NextHandler, type X207Middleware, type X207MiddlewareOptions, type X207RouteConfig } from "./middleware.js";
import { MeterRejection, resolvePrice, type MeterQuote } from "./metering.js";
import { priceToAmount } from "./price.js";

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

const RISK = "Penyedia bisa memberi hasil buruk atau tidak menjawab; pembeli paling banyak rugi satu satuan per kejadian karena bayar per pemakaian.";
const JOB = "Job panjang dibayar bertahap dengan voucher kumulatif (MeteredJob) supaya risiko tiap pihak paling banyak satu potongan.";

export const METERED_PRESETS: Readonly<Record<MeteredKind, MeteredPreset>> = {
  cpu: { assetType: "compute:cpu-idle", catalogNo: 31, units: ["minute", "job"], warnings: [RISK, JOB] },
  gpu: { assetType: "compute:gpu-hours", catalogNo: 32, units: ["minute", "job"], warnings: [RISK, JOB] },
  storage: { assetType: "storage:capacity", catalogNo: 33, units: ["GB", "day"], warnings: [RISK, "Penyimpanan tidak dijamin tersedia atau tidak hilang; simpan salinan lain untuk data penting."] },
  cdn: { assetType: "cdn:static-cache", catalogNo: 34, units: ["GB", "request"], warnings: [RISK] },
  inference: { assetType: "model:inference", catalogNo: 35, units: ["request", "call"], warnings: [RISK, "Keluaran model tidak dijamin benar; uji acak dan reputasi yang menilai penyedia, bukan protokol."] },
  "fine-tuning": { assetType: "model:fine-tuning", catalogNo: 36, units: ["job"], warnings: [RISK, JOB, "Data latih yang dikirim ke penyedia bisa dibaca penyedia; jangan kirim data rahasia atau data pribadi pihak ketiga."] },
  "data-feed": { assetType: "oracle:data-feed", catalogNo: 44, units: ["call", "request"], warnings: [RISK, "Nilai umpan data tidak diverifikasi protokol."] },
  "iot-sensor": { assetType: "iot:sensor-data", catalogNo: 45, units: ["call", "day"], warnings: [RISK, "Data sensor tidak boleh memuat data pribadi pihak ketiga."] },
  "gas-relayer": { assetType: "gas:relayer", catalogNo: 47, units: ["request", "call"], warnings: [RISK] },
  "priority-slot": { assetType: "queue:priority-slot", catalogNo: 49, units: ["request", "day"], warnings: [RISK] },
  "proxy-bandwidth": { assetType: "network:proxy-bandwidth", catalogNo: 55, units: ["GB", "request"], warnings: [RISK, "Proxy dan bandwidth tunduk pada hukum setempat; penyedia dan pembeli bertanggung jawab atas lalu lintas yang lewat."] },
  "home-device": { assetType: "compute:home-device", catalogNo: 90, units: ["minute", "day", "job"], warnings: [RISK, "Listrik, keamanan jaringan, dan perangkat keras ditanggung pemiliknya sendiri."] },
};

/** Batas atas per request bila pemanggil tidak menyebutnya: cukup untuk satu pemakaian wajar, dan menolak tagihan raksasa sebelum 402. */
export const DEFAULT_MAX_QUANTITY: Readonly<Record<MeteredUnit, number>> = { call: 1000, request: 1000, minute: 1440, day: 31, GB: 1000, job: 1 };

export type MeteredContext = { unit: MeteredUnit; quantity: string; kind: MeteredKind };

export type MeteredEndpointOptions = {
  kind: MeteredKind;
  /** Satuan; bawaannya satuan pertama preset. Hanya satuan yang cocok dengan jenisnya yang diterima. */
  unit?: MeteredUnit;
  /** Harga satu satuan dalam credit (format `price` biasa). */
  unitPrice: string | number;
  /** Jumlah satuan dari request; bawaan: query `quantity`, atau 1. Boleh melempar `MeterRejection`. */
  quantity?: (request: Request) => number | string | Promise<number | string>;
  /** Batas atas per request; bawaan `DEFAULT_MAX_QUANTITY[unit]`. */
  maxQuantity?: number | string;
  description?: string;
  /** Pekerjaan penjual; jalan hanya setelah voucher sah, dengan jumlah yang dibayar. */
  handler: (request: Request, context: MeteredContext) => Response | Promise<Response>;
};

export type MeteredEndpoint = {
  kind: MeteredKind;
  assetType: string;
  catalogNo: number;
  assetClass: "D";
  unit: MeteredUnit;
  /** Harga satu satuan, satuan credit terkecil (teks). */
  unitPriceAtomic: string;
  maxQuantity: string;
  warnings: string[];
  /** Konfigurasi rute untuk `x207Middleware({ routes: { "/path": endpoint.route } })`. */
  route: X207RouteConfig;
  handler: NextHandler;
  /** `Listing.detail` untuk BE-050: `{"unit","unit_price","endpoint"}` ditambah `kind`. `endpoint` harus https tanpa kredensial. */
  listingDetail(endpoint: string): string;
  /** Middleware siap pakai untuk satu path: `(request) => Response` dengan 402, verifikasi, handler, dan penyelesaian seperti biasa. */
  mount(path: string, options: Omit<X207MiddlewareOptions, "routes">): (request: Request) => Promise<Response>;
};

const SECRET_PARAM = /^(api[-_]?key|key|token|access[-_]?token|secret|password|passwd|pwd|auth|authorization|signature|sig|credential|session)$/i;

function checkEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new MeterRejection("endpoint bukan URL");
  }
  if (url.protocol !== "https:") throw new MeterRejection("endpoint harus https");
  if (url.username !== "" || url.password !== "" || url.hash !== "") throw new MeterRejection("endpoint tidak boleh memuat kredensial atau fragmen");
  for (const name of url.searchParams.keys()) if (SECRET_PARAM.test(name)) throw new MeterRejection(`endpoint tidak boleh memuat kredensial di query (${name})`);
}

/** Satu baris konfigurasi per jenis: lihat `METERED_PRESETS` untuk dua belas jenis. Melempar `MeterRejection` untuk jenis, satuan, atau harga yang tidak sah. */
export function createMeteredEndpoint(options: MeteredEndpointOptions): MeteredEndpoint {
  const preset = (METERED_PRESETS as Record<string, MeteredPreset | undefined>)[options.kind];
  if (!preset) throw new MeterRejection(`jenis tidak dikenal: ${JSON.stringify(options.kind)}; pilih salah satu dari ${METERED_KINDS.join(", ")}`);
  const unit = options.unit ?? preset.units[0];
  if (!preset.units.includes(unit)) throw new MeterRejection(`satuan ${JSON.stringify(unit)} tidak cocok untuk ${options.kind}; pilih ${preset.units.join(" atau ")}`);
  const unitPriceAtomic = (() => {
    try {
      return priceToAmount(options.unitPrice);
    } catch (e) {
      throw new MeterRejection(e instanceof Error ? e.message : String(e));
    }
  })();
  const maxQuantity = String(options.maxQuantity ?? DEFAULT_MAX_QUANTITY[unit]);
  const quantityOf = options.quantity ?? ((request: Request) => new URL(request.url).searchParams.get("quantity") ?? "1");
  const price = async (request: Request): Promise<MeterQuote> => ({ unit, quantity: await quantityOf(request), unitPrice: options.unitPrice, maxQuantity });
  const route: X207RouteConfig = { price, maxQuantity, ...(options.description !== undefined ? { description: options.description } : {}) };
  // `resolvePrice` already normalised and checked the quantity before 402, so here it is read again only to hand it to the handler
  const handler: NextHandler = async (request) => {
    const { meter } = await resolvePrice(price, request, maxQuantity);
    return options.handler(request, { unit, quantity: meter!.quantity, kind: options.kind });
  };
  return {
    kind: options.kind,
    assetType: preset.assetType,
    catalogNo: preset.catalogNo,
    assetClass: "D",
    unit,
    unitPriceAtomic,
    maxQuantity,
    warnings: [...preset.warnings],
    route,
    handler,
    listingDetail(endpoint) {
      checkEndpoint(endpoint);
      return JSON.stringify({ kind: options.kind, unit, unit_price: unitPriceAtomic, endpoint });
    },
    mount(path, base) {
      const middleware: X207Middleware = x207Middleware({ ...base, routes: { [path]: route } });
      return (request) => middleware(request, handler);
    },
  };
}
