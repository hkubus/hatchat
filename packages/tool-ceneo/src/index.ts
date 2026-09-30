import type { Part, Plugin, Tool } from "@hat/core";
import { z } from "zod";

const BASE_URL = "https://www.ceneo.pl";

const HEADERS: Record<string, string> = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "pl-PL,pl;q=0.9,en;q=0.8",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
};

/** Tools the Scout MCP server (second-hand marketplace scans) registers. */
const SCOUT_TOOL_PREFIX = "mcp__scout__";

/**
 * Appended to the system prompt while the plugin is active, so the model picks
 * Ceneo for retail prices even when it doesn't read every tool description
 * closely. Scout is only named when its tools are actually registered: telling
 * the model to avoid tools it doesn't have would only confuse it.
 */
export function ceneoPrompt(toolNames: readonly string[] = []): string {
  const base =
    "Prices of new products: use ceneo_search and ceneo_product (Ceneo, the Polish price " +
    "comparison site; prices in PLN from Polish shops) whenever possible";
  if (!toolNames.some((name) => name.startsWith(SCOUT_TOOL_PREFIX))) return `${base}.`;
  return (
    `${base}, instead of Scout (${SCOUT_TOOL_PREFIX}* tools). Use Scout only for used / ` +
    "second-hand listings, or when Ceneo does not carry the product."
  );
}

export interface CeneoProduct {
  id: string;
  name: string;
  url: string;
  /** Lowest offer price in PLN. */
  price?: number;
  shops?: number;
  rating?: number;
  reviews?: number;
  /** Key specs as "Label: value". */
  params: string[];
}

export interface CeneoOffer {
  shop: string;
  price: number;
  title?: string;
  shopRating?: number;
  shopReviews?: number;
  freeDelivery: boolean;
  /** e.g. "Wysyłka w 1 dzień". */
  shipping?: string;
}

export interface CeneoProductPage {
  id: string;
  url: string;
  name?: string;
  lowPrice?: number;
  highPrice?: number;
  offerCount?: number;
  rating?: number;
  ratingCount?: number;
  offers: CeneoOffer[];
}

export const ceneoConfigSchema = z.object({
  maxResults: z
    .number()
    .int()
    .positive()
    .max(30)
    .optional()
    .describe("Products per search and offers per product when the model does not ask (default 10)."),
});

const searchSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe('Product to look for, as you would type it on Ceneo, e.g. "iphone 15 128gb".'),
  min_price: z.number().nonnegative().optional().describe("Only products from this price (PLN)."),
  max_price: z.number().positive().optional().describe("Only products up to this price (PLN)."),
  limit: z
    .number()
    .int()
    .positive()
    .max(30)
    .optional()
    .describe("Maximum number of products to return (default 10, max 30)."),
});

const productSchema = z.object({
  product: z
    .string()
    .min(1)
    .describe('Ceneo product id from ceneo_search (e.g. "138536500") or a ceneo.pl product URL.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(30)
    .optional()
    .describe("Maximum number of offers to return, cheapest first (default 10, max 30)."),
});

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return HTML_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** "2 649,00" / "4,9" / "2649.5" → number. */
export function parsePolishNumber(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const value = Number.parseFloat(text.replace(/[\s ]/g, "").replace(",", "."));
  return Number.isFinite(value) ? value : undefined;
}

function attr(attrs: string, name: string): string | undefined {
  const value = new RegExp(`\\s${name}="([^"]*)"`, "i").exec(attrs)?.[1];
  return value === undefined ? undefined : decodeEntities(value).trim();
}

function firstMatch(re: RegExp, text: string): string | undefined {
  return re.exec(text)?.[1];
}

/** Ceneo's price markup: `<span class="value">2 649</span><span class="penny">,00</span>`. */
function parsePriceMarkup(html: string): number | undefined {
  const match = /<span class="value">([^<]*)<\/span>(?:\s*<span class="penny">([^<]*)<\/span>)?/.exec(
    html,
  );
  return match ? parsePolishNumber(`${match[1]}${match[2] ?? ""}`) : undefined;
}

export function searchUrl(query: string, minPrice?: number, maxPrice?: number): string {
  const words = query.trim().split(/\s+/).map(encodeURIComponent).join("+");
  let url = `${BASE_URL}/;szukaj-${words}`;
  if (minPrice !== undefined || maxPrice !== undefined) {
    if (minPrice !== undefined) url += `;m${Math.floor(minPrice)}`;
    if (maxPrice !== undefined) url += `;n${Math.ceil(maxPrice)}`;
    url += ".htm";
  }
  return url;
}

export function isCeneoHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "ceneo.pl" || host.endsWith(".ceneo.pl");
}

/** The product id when `url` is a ceneo.pl product page (`/<id>...`), else undefined. */
export function productIdFromUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (!isCeneoHost(parsed.hostname)) return undefined;
  return /^\/(\d+)(?:[;#?/]|$)/.exec(parsed.pathname)?.[1];
}

/** Accept a bare product id or any ceneo.pl URL whose path starts with one. */
export function parseProductRef(ref: string): string {
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`"${ref}" is neither a Ceneo product id nor a URL`);
  }
  if (!isCeneoHost(url.hostname)) {
    throw new Error(`"${ref}" is not a ceneo.pl URL`);
  }
  const id = /^\/(\d+)/.exec(url.pathname)?.[1];
  if (!id) throw new Error(`"${ref}" is not a Ceneo product page (expected ceneo.pl/<id>)`);
  return id;
}

/**
 * Parse a Ceneo search/category listing. Each product row carries its id, name
 * and lowest price as data attributes, which are steadier than the visible
 * markup; the rest (shop count, rating, specs) is best-effort.
 */
export function parseSearchHtml(html: string, limit: number): CeneoProduct[] {
  // Class order and whitespace vary between categories; the js_ hook is stable.
  const rowRe = /<div class="[^"]*\bjs_category-list-item\b[^"]*"([^>]*)>/g;
  const rows: { attrs: string; start: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = rowRe.exec(html))) {
    rows.push({ attrs: match[1], start: match.index, end: match.index + match[0].length });
  }

  const products: CeneoProduct[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < rows.length && products.length < limit; i++) {
    const row = rows[i];
    const id = attr(row.attrs, "data-pid") ?? attr(row.attrs, "data-productid");
    if (!id || seen.has(id)) continue;
    const segment = html.slice(row.end, rows[i + 1]?.start ?? html.length);
    const name =
      attr(row.attrs, "data-productName") ||
      stripTags(firstMatch(/class="cat-prod-row__name">([\s\S]*?)<\/strong>/, segment) ?? "");
    if (!name) continue;
    seen.add(id);

    const params: string[] = [];
    const paramsHtml = firstMatch(/<ul class="prod-params[^"]*">([\s\S]*?)<\/ul>/, segment);
    if (paramsHtml) {
      for (const item of paramsHtml.matchAll(/<li>([\s\S]*?)<\/li>/g)) {
        const text = stripTags(item[1]);
        if (text) params.push(text);
      }
    }

    products.push({
      id,
      name,
      url: `${BASE_URL}/${id}`,
      price:
        parsePolishNumber(attr(row.attrs, "data-productminprice")) ??
        parsePriceMarkup(firstMatch(/class="cat-prod-row__price">([\s\S]*)/, segment) ?? ""),
      shops: parsePolishNumber(firstMatch(/\bw\s+(\d+)\s+sklep/, segment)),
      rating: parsePolishNumber(firstMatch(/class="product-score">\s*([\d,]+)/, segment)),
      reviews: parsePolishNumber(firstMatch(/(\d+)\s+opini/, segment)),
      params,
    });
  }
  return products;
}

interface JsonLdProduct {
  name?: unknown;
  offers?: { lowPrice?: unknown; highPrice?: unknown; offerCount?: unknown };
  aggregateRating?: { ratingValue?: unknown; ratingCount?: unknown };
}

function num(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number.parseFloat(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}

/**
 * Parse a Ceneo product page: the summary (name, price range, offer count)
 * from its JSON-LD, and the offers from the rendered list, cheapest first.
 */
export function parseProductHtml(html: string, id: string, limit: number): CeneoProductPage {
  const page: CeneoProductPage = { id, url: `${BASE_URL}/${id}`, offers: [] };

  for (const script of html.matchAll(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
  )) {
    let data: JsonLdProduct;
    try {
      data = JSON.parse(script[1]) as JsonLdProduct;
    } catch {
      continue;
    }
    if (!data || typeof data !== "object" || !data.offers) continue;
    if (typeof data.name === "string") page.name = decodeEntities(data.name);
    page.lowPrice = num(data.offers.lowPrice);
    page.highPrice = num(data.offers.highPrice);
    page.offerCount = num(data.offers.offerCount);
    page.rating = num(data.aggregateRating?.ratingValue);
    page.ratingCount = num(data.aggregateRating?.ratingCount);
    break;
  }
  if (!page.name) {
    const title = firstMatch(/<h1[^>]*>([\s\S]*?)<\/h1>/, html);
    if (title) page.name = stripTags(title) || undefined;
  }

  // Promoted and standard offers are separate lists of the same item markup,
  // and the same offer can appear in both.
  const seen = new Set<string>();
  for (const segment of offerSegments(html)) {
    const priceHtml = firstMatch(/class="product-offer__product__price">([\s\S]*)/, segment);
    const price =
      (priceHtml ? parsePriceMarkup(priceHtml) : undefined) ??
      parsePolishNumber(attr(segment, "data-Price"));
    const shop =
      attr(segment, "data-ShopUrl") ||
      decodeEntities(
        firstMatch(/class="product-offer__logo">[\s\S]*?<img[^>]*\balt="([^"]*)"/, segment) ?? "",
      ).trim();
    if (price === undefined || !shop) continue;
    const offerId = firstMatch(/\bdata-offer="(\d+)"/, segment);
    const keys = [`shop:${normalizeShop(shop)}|${price}`];
    if (offerId) keys.push(`offer:${offerId}`);
    if (keys.some((key) => seen.has(key))) continue;
    for (const key of keys) seen.add(key);
    const title =
      firstMatch(/class="short-name__txt">([^<]*)</, segment) ??
      firstMatch(/offer-details__name[^"]*">\s*<a[^>]*\btitle="([^"]*)"/, segment);
    page.offers.push({
      shop,
      price,
      title: title ? decodeEntities(title).trim() || undefined : undefined,
      shopRating: parsePolishNumber(firstMatch(/Ocena ([\d,]+) \/ 5/, segment)),
      shopReviews: parsePolishNumber(firstMatch(/>\s*(\d+)\s+opini/, segment)),
      freeDelivery: segment.includes("Darmowa wysyłka"),
      shipping: firstMatch(/class="instock">\s*([^<]*?)\s*</, segment) || undefined,
    });
  }
  page.offers.sort((a, b) => a.price - b.price);
  page.offers = page.offers.slice(0, limit);
  return page;
}

function normalizeShop(shop: string): string {
  return shop
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

const OFFER_ITEM = /<li class="product-offers__list__item\b/g;

/**
 * The markup of each offer item. An item ends at its matching `</li>` (items
 * nest lists of their own), so the last offer does not run on into whatever
 * follows the offer list — reviews and footers also say "Darmowa wysyłka" and
 * "N opinii". Without a matching close, it ends at the next item, or at the
 * end of its offer list.
 */
function offerSegments(html: string): string[] {
  const starts = [...html.matchAll(OFFER_ITEM)].map((match) => match.index ?? 0);
  return starts.map((start, i) => {
    const next = starts[i + 1] ?? html.length;
    const close = matchingLiClose(html, start);
    if (close !== undefined) return html.slice(start, Math.min(close, next));
    const listEnd = html.indexOf("</ul>", start);
    return html.slice(start, Math.min(next, listEnd === -1 ? html.length : listEnd));
  });
}

/** Offset just past the `</li>` closing the `<li` at `start`, if there is one. */
function matchingLiClose(html: string, start: number): number | undefined {
  const tags = /<(\/?)li\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 0;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html))) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return match.index + match[0].length;
  }
  return undefined;
}

/**
 * Ceneo sends an exact-match search straight to the product page. Read that
 * page as a one-product search result.
 */
export function productPageAsSearchResult(html: string, id: string): CeneoProduct | undefined {
  const page = parseProductHtml(html, id, 0);
  if (!page.name) return undefined;
  return {
    id,
    name: page.name,
    url: page.url,
    price: page.lowPrice,
    shops: page.offerCount,
    rating: page.rating,
    reviews: page.ratingCount,
    params: [],
  };
}

export function formatPrice(value: number): string {
  return `${value.toFixed(2)} zł`;
}

export function formatSearch(query: string, products: CeneoProduct[]): Part[] {
  if (products.length === 0) {
    return [{ type: "text", text: `No Ceneo products found for "${query}".` }];
  }
  const lines = products.map((product, index) => {
    const facts = [
      product.price !== undefined ? `from ${formatPrice(product.price)}` : undefined,
      product.shops !== undefined ? `${product.shops} shop${product.shops === 1 ? "" : "s"}` : undefined,
      product.rating !== undefined
        ? `rated ${product.rating}/5${product.reviews !== undefined ? ` (${product.reviews} reviews)` : ""}`
        : undefined,
    ].filter(Boolean);
    const params = product.params.length > 0 ? `\n   ${product.params.join("; ")}` : "";
    return `${index + 1}. ${product.name}\n   ${facts.join(" · ")}\n   id ${product.id} · ${product.url}${params}`;
  });
  return [
    {
      type: "text",
      text:
        `Ceneo results for "${query}" (lowest price per product, new items from Polish shops):\n\n` +
        `${lines.join("\n\n")}\n\nUse ceneo_product with an id for the per-shop offers.`,
    },
  ];
}

export function formatProduct(page: CeneoProductPage): Part[] {
  const summary = [
    page.lowPrice !== undefined && page.highPrice !== undefined
      ? `Price range: ${formatPrice(page.lowPrice)} – ${formatPrice(page.highPrice)}`
      : undefined,
    page.offerCount !== undefined ? `Offers: ${page.offerCount}` : undefined,
    page.rating !== undefined
      ? `Rating: ${page.rating}/5${page.ratingCount !== undefined ? ` (${page.ratingCount} reviews)` : ""}`
      : undefined,
  ].filter(Boolean);
  const offers = page.offers.map((offer, index) => {
    const facts = [
      offer.shopRating !== undefined
        ? `shop rated ${offer.shopRating}/5${offer.shopReviews !== undefined ? ` (${offer.shopReviews})` : ""}`
        : undefined,
      offer.freeDelivery ? "free delivery" : undefined,
      offer.shipping,
    ].filter(Boolean);
    const title = offer.title ? `\n   ${offer.title}` : "";
    return `${index + 1}. ${formatPrice(offer.price)} — ${offer.shop}${facts.length ? ` (${facts.join(", ")})` : ""}${title}`;
  });
  const header = [`${page.name ?? `Ceneo product ${page.id}`}`, page.url, ...summary].join("\n");
  // Ceneo renders only the first page of offers; the rest load in the browser.
  const partial =
    page.offerCount !== undefined && page.offerCount > offers.length
      ? ` (${offers.length} of ${page.offerCount}; the full list is on the page)`
      : "";
  const body =
    offers.length > 0
      ? `Offers, cheapest first${partial}:\n\n${offers.join("\n")}`
      : "No offers could be read from the page.";
  return [{ type: "text", text: `${header}\n\n${body}` }];
}

/** Product pages are a few hundred KB; anything far bigger is not Ceneo. */
export const MAX_PAGE_BYTES = 5 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;

export interface FetchedPage {
  status: number;
  ok: boolean;
  /** Where the redirects ended up. */
  url: string;
  body: string;
}

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * GET a ceneo.pl page. Redirects are followed by hand so that every hop, not
 * just the first, has to stay on ceneo.pl over https; the body is capped, and
 * the request has its own timeout on top of the turn's signal.
 */
export async function fetchPage(
  url: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  options: FetchOptions = {},
): Promise<FetchedPage> {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_PAGE_BYTES;
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      assertCeneoUrl(current);
      const response = await fetchImpl(current, { headers: HEADERS, redirect: "manual", signal: combined });
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel().catch(() => {});
        if (hop >= MAX_REDIRECTS) throw new Error("Ceneo redirected too many times");
        current = new URL(location, current).toString();
        continue;
      }
      const body = await readCapped(response, maxBytes);
      return { status: response.status, ok: response.ok, url: current, body };
    }
  } catch (error) {
    if (timeout.aborted && !signal.aborted) {
      const limit = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`;
      throw new Error(`Ceneo did not answer within ${limit}`);
    }
    throw error;
  }
}

function assertCeneoUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !isCeneoHost(parsed.hostname)) {
    throw new Error(`Ceneo redirected outside ceneo.pl (${parsed.protocol}//${parsed.host})`);
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const tooLarge = () => new Error(`Ceneo page is larger than ${Math.round(maxBytes / 1024)} KB`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface CeneoToolOptions {
  maxResults?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
  /** Per-request timeout; defaults to FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Response size cap; defaults to MAX_PAGE_BYTES. */
  maxBytes?: number;
}

export function createCeneoTools(options: CeneoToolOptions = {}): Tool[] {
  const fetchImpl = options.fetch ?? fetch;
  const defaultLimit = options.maxResults ?? 10;
  const fetchOptions: FetchOptions = { timeoutMs: options.timeoutMs, maxBytes: options.maxBytes };

  const search: Tool = {
    name: "ceneo_search",
    description:
      "Search Ceneo.pl, the Polish price comparison site, for new products and their lowest " +
      "price across Polish shops (PLN). Prefer this over second-hand marketplace tools for the " +
      "price of anything bought new. Returns product ids for ceneo_product.",
    schema: searchSchema,
    requiresApproval: false,
    async execute(raw, ctx): Promise<Part[]> {
      const args = searchSchema.parse(raw);
      if (
        args.min_price !== undefined &&
        args.max_price !== undefined &&
        args.min_price > args.max_price
      ) {
        return [
          {
            type: "text",
            text: `Ceneo search not run: min_price (${args.min_price}) is above max_price (${args.max_price}).`,
          },
        ];
      }
      const url = searchUrl(args.query, args.min_price, args.max_price);
      try {
        const page = await fetchPage(url, fetchImpl, ctx.signal, fetchOptions);
        if (!page.ok) throw new Error(`Ceneo returned HTTP ${page.status}`);
        // An exact match redirects straight to the product page.
        const productId = productIdFromUrl(page.url);
        const direct = productId ? productPageAsSearchResult(page.body, productId) : undefined;
        const products = direct
          ? [direct]
          : parseSearchHtml(page.body, args.limit ?? defaultLimit);
        ctx.logger.debug(`ceneo_search "${args.query}": ${products.length} product(s)`);
        return formatSearch(args.query, products);
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.warn("ceneo_search failed", message);
        return [{ type: "text", text: `Ceneo search failed: ${message}` }];
      }
    },
  };

  const product: Tool = {
    name: "ceneo_product",
    description:
      "List the shop offers for one Ceneo.pl product, cheapest first: price (PLN), shop, shop " +
      "rating and delivery. Takes a product id from ceneo_search or a ceneo.pl product URL.",
    schema: productSchema,
    requiresApproval: false,
    async execute(raw, ctx): Promise<Part[]> {
      const args = productSchema.parse(raw);
      try {
        const id = parseProductRef(args.product);
        const page = await fetchPage(`${BASE_URL}/${id}`, fetchImpl, ctx.signal, fetchOptions);
        // Unknown ids answer 404 or 500 rather than a clean "not found".
        if (page.status === 404 || page.status >= 500) {
          return [{ type: "text", text: `No Ceneo product with id ${id} (HTTP ${page.status}).` }];
        }
        if (!page.ok) throw new Error(`Ceneo returned HTTP ${page.status}`);
        return formatProduct(parseProductHtml(page.body, id, args.limit ?? defaultLimit));
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        ctx.logger.warn("ceneo_product failed", message);
        return [{ type: "text", text: `Ceneo product lookup failed: ${message}` }];
      }
    },
  };

  return [search, product];
}

export function createCeneoPlugin(): Plugin {
  return {
    id: "ceneo",
    name: "Ceneo",
    version: "0.1.0",
    description:
      "Check prices of new products on Ceneo.pl, the Polish price comparison site (keyless).",
    permissions: [`net:${BASE_URL}`],
    configSchema: ceneoConfigSchema,
    activate(ctx) {
      const config = ctx.getConfig<z.infer<typeof ceneoConfigSchema>>();
      for (const tool of createCeneoTools({ maxResults: config.maxResults })) {
        ctx.register.tool(tool);
      }
    },
  };
}
