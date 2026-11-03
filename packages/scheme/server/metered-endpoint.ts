// Template endpoint terukur (SD-064, pipeline P5, kelas D). Satu baris konfigurasi per jenis sumber daya: `createMeteredEndpoint({ kind, unitPrice, handler })` memberi rute
// `x207Middleware` dengan harga per satuan (SD-062), batas atas per request, `detail` listing (BE-050), dan peringatan jenisnya. Preset dua belas jenis mengikuti katalog barter
// (`asset_type` D10 dan nomor katalog); satuan hidup di SDK, listing, dan voucher, kontrak tidak berubah. Job panjang memakai `MeteredJob` (SD-063).
import { x207Middleware, type NextHandler, type X207Middleware, type X207MiddlewareOptions, type X207RouteConfig } from "./middleware.js";
import {
  DEFAULT_MAX_QUANTITY, METERED_KINDS, METERED_PRESETS, endpointProblem, resourceListingDetail, type MeteredKind, type MeteredPreset, type MeteredUnit,
} from "@x207/core";
import { MeterRejection, resolvePrice, type MeterQuote } from "./metering.js";
import { priceToAmount } from "./price.js";

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
      const problem = endpointProblem(endpoint);
      if (problem !== null) throw new MeterRejection(problem);
      return resourceListingDetail({ kind: options.kind, unit, unitPriceAtomic, endpoint });
    },
    mount(path, base) {
      const middleware: X207Middleware = x207Middleware({ ...base, routes: { [path]: route } });
      return (request) => middleware(request, handler);
    },
  };
}
