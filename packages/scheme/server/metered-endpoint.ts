// Metered endpoint template (SD-064, pipeline P5, class D). One config line per resource kind: `createMeteredEndpoint({ kind, unitPrice, handler })` gives a route for
// `x207Middleware` with a per-unit price (SD-062), a per-request upper bound, the listing `detail` (BE-050), and the kind's warning. The twelve-kind presets follow the barter catalog
// (D10 `asset_type` and catalog number); units live in the SDK, listing, and voucher, the contract is unchanged. Long jobs use `MeteredJob` (SD-063).
import { x207Middleware, type NextHandler, type X207Middleware, type X207MiddlewareOptions, type X207RouteConfig } from "./middleware.js";
import {
  DEFAULT_MAX_QUANTITY, METERED_KINDS, METERED_PRESETS, endpointProblem, resourceListingDetail, type MeteredKind, type MeteredPreset, type MeteredUnit,
} from "@x207/core";
import { MeterRejection, resolvePrice, type MeterQuote } from "./metering.js";
import { priceToAmount } from "./price.js";

export type MeteredContext = { unit: MeteredUnit; quantity: string; kind: MeteredKind };

export type MeteredEndpointOptions = {
  kind: MeteredKind;
  /** Unit; defaults to the preset's first unit. Only units that match the kind are accepted. */
  unit?: MeteredUnit;
  /** Price of one unit in credit (the usual `price` format). */
  unitPrice: string | number;
  /** Number of units in the request; default: the `quantity` query, or 1. May throw `MeterRejection`. */
  quantity?: (request: Request) => number | string | Promise<number | string>;
  /** Upper bound per request; defaults to `DEFAULT_MAX_QUANTITY[unit]`. */
  maxQuantity?: number | string;
  description?: string;
  /** Seller's work; runs only after a valid voucher, with the amount paid. */
  handler: (request: Request, context: MeteredContext) => Response | Promise<Response>;
};

export type MeteredEndpoint = {
  kind: MeteredKind;
  assetType: string;
  catalogNo: number;
  assetClass: "D";
  unit: MeteredUnit;
  /** Price of one unit, smallest credit unit (text). */
  unitPriceAtomic: string;
  maxQuantity: string;
  warnings: string[];
  /** Route configuration for `x207Middleware({ routes: { "/path": endpoint.route } })`. */
  route: X207RouteConfig;
  handler: NextHandler;
  /** `Listing.detail` for BE-050: `{"unit","unit_price","endpoint"}` plus `kind`. `endpoint` must be https without credentials. */
  listingDetail(endpoint: string): string;
  /** Ready-to-use middleware for one path: `(request) => Response` with 402, verification, handler, and settlement as usual. */
  mount(path: string, options: Omit<X207MiddlewareOptions, "routes">): (request: Request) => Promise<Response>;
};

/** One config line per kind: see `METERED_PRESETS` for the twelve kinds. Throws `MeterRejection` for an invalid kind, unit, or price. */
export function createMeteredEndpoint(options: MeteredEndpointOptions): MeteredEndpoint {
  const preset = (METERED_PRESETS as Record<string, MeteredPreset | undefined>)[options.kind];
  if (!preset) throw new MeterRejection(`unknown kind: ${JSON.stringify(options.kind)}; choose one of ${METERED_KINDS.join(", ")}`);
  const unit = options.unit ?? preset.units[0];
  if (!preset.units.includes(unit)) throw new MeterRejection(`unit ${JSON.stringify(unit)} does not fit ${options.kind}; choose ${preset.units.join(" or ")}`);
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
