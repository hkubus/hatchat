import assert from "node:assert/strict";
import { test } from "node:test";
import type { Logger, Part, PluginContext, ToolContext } from "@hat/core";
import {
  ceneoPrompt,
  createCeneoPlugin,
  createCeneoTools,
  parsePolishNumber,
  parseProductHtml,
  parseProductRef,
  parseSearchHtml,
  productIdFromUrl,
  searchUrl,
} from "./index.js";

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function toolContext(signal = new AbortController().signal): ToolContext {
  return {
    sessionId: "s1",
    host: {} as ToolContext["host"],
    secrets: { get: async () => undefined },
    approval: { request: async () => "approve" },
    audit: { record() {} },
    logger,
    signal,
  };
}

function textOf(parts: Part[]): string {
  return parts.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

// Trimmed from a real ceneo.pl search listing.
const SEARCH_HTML = `
<div class="category-list-body js_search-results">
 <div class="cat-prod-row
             js_category-list-item
             js_clickHashData
         "
data-pid="138536500"
data-productminprice="2649" data-brand="Apple" data-productName="Apple iPhone 15 128GB Czarny" data-productid="138536500"
>
<strong class="cat-prod-row__name"><a href="/138536500"><span >Apple iPhone 15 128GB Czarny</span></a></strong>
<span class="product-score">
4,9
<span class="screen-reader-text">/<span>5</span></span>
</span>
<a href="/138536500###tab=reviews_scroll" class="product-reviews-link">
2344 opinie
</a>
 <ul class="prod-params cat-prod-row__params">
 <li>
Przekątna ekranu:
 <strong>6,1 cala</strong>
 </li>
 <li>
Pamięć wewnętrzna:
 <strong>128 GB</strong>
 </li>
</ul>
<div class="cat-prod-row__price">
<span class="price-prefix">od</span><span class="price-format nowrap"><span class="price"><span class="value">2 649</span><span class="penny">,00</span></span>zł</span>
<span class="shop-numb">w 26 sklepach</span>
</div>
</div>
    <div class="
             cat-prod-row
             js_category-list-item
         "
data-pid="157145030"
data-productName="Apple iPhone 15 128GB  Ż&#243;łty"
>
<div class="cat-prod-row__price">
<span class="price-format nowrap"><span class="price"><span class="value">2 647</span><span class="penny">,99</span></span>zł</span>
</div>
</div>
<script>$('.js_category-list-item')</script>
`;

// Trimmed from a real ceneo.pl product page: one promoted offer with data
// attributes, one "buy on Ceneo" offer without them.
const PRODUCT_HTML = `
<script type="application/ld+json">
{ "name": "Apple iPhone 15 128GB Czarny", "sku": "138536500",
  "offers": { "@type": "AggregateOffer", "lowPrice": 2649.00, "highPrice": 5039.70, "priceCurrency": "PLN", "offerCount": 26 },
  "aggregateRating": { "@type": "AggregateRating", "ratingValue": 4.85, "ratingCount": 2344 } }
</script>
<ul class="product-offers__list js_bidding-offers">
<li class="product-offers__list__item js_productOfferGroupItem"
    data-ShopUrl="electro.pl" data-ProductId="138536500" data-Price="2892.28">
  <div class="product-offer__logo"><a class='store-logo' href='#'><img src="x.jpg" alt="electro.pl" /></a></div>
  <span class="screen-reader-text">Ocena 1,7 / 5</span>
  <span class="link link--accent js_mini-shop-info">23 opinie</span>
  <div class="product-offer__product__offer-details__name short-name">
    <a href="#" title="Smartfon APPLE iPhone 15 &quot;Czarny&quot;" class="go-to-shop">
      <span class="short-name__txt">Smartfon APPLE iPhone 15 &quot;Czarny&quot;</span>
    </a>
  </div>
  <div class="product-offer__product__price">
    <span class="price-format nowrap"><span class="price"><span class="value">2 892</span><span class="penny">,28</span></span>zł</span>
    <div class="free-delivery-label">Darmowa wysyłka</div>
    <span class="instock">
        Wysyłka w 1 dzień
    </span>
  </div>
</li>
</ul>
<ul class="product-offers__list js_normal-offers">
<li class="product-offers__list__ado-item"><span class="value">1</span></li>
<li class="product-offers__list__item js_productOfferGroupItem"
    data-notFullyVisible="">
  <div class="product-offer__container js_product-offer" data-offer="582280422" data-shop="382">
  <div class="product-offer__logo"><div class="shop-label">Firma</div><a class='store-logo' href='#'><img src="y.jpg" alt="abfoto.pl" loading="lazy" /></a></div>
  <span class="screen-reader-text">Ocena 4,7 / 5</span>
  <span class="link">1754 opinie</span>
  <div class="product-offer__product__offer-details__name short-name">
    <a href="#" target="_self"  title="Apple iPhone 15 128 GB Czarny">x</a>
  </div>
  <div class="product-offer__product__price">
    <span class="price-format nowrap"><span class="price"><span class="value">2 649</span><span class="penny">,00</span></span>zł</span>
  </div>
  </div>
</li>
</ul>
`;

test("parsePolishNumber handles thousands spaces and decimal commas", () => {
  assert.equal(parsePolishNumber("2 649,00"), 2649);
  assert.equal(parsePolishNumber("2 892,28"), 2892.28);
  assert.equal(parsePolishNumber("4,9"), 4.9);
  assert.equal(parsePolishNumber("2647.99"), 2647.99);
  assert.equal(parsePolishNumber(""), undefined);
  assert.equal(parsePolishNumber("abc"), undefined);
});

test("searchUrl encodes words and adds price filters", () => {
  assert.equal(searchUrl("iphone 15"), "https://www.ceneo.pl/;szukaj-iphone+15");
  assert.equal(searchUrl("  słuchawki  sony "), "https://www.ceneo.pl/;szukaj-s%C5%82uchawki+sony");
  assert.equal(
    searchUrl("iphone", 2000.5, 2800.2),
    "https://www.ceneo.pl/;szukaj-iphone;m2000;n2801.htm",
  );
  assert.equal(searchUrl("iphone", undefined, 1500), "https://www.ceneo.pl/;szukaj-iphone;n1500.htm");
});

test("parseProductRef accepts ids and ceneo URLs only", () => {
  assert.equal(parseProductRef("138536500"), "138536500");
  assert.equal(parseProductRef("https://www.ceneo.pl/138536500"), "138536500");
  assert.equal(parseProductRef("https://www.ceneo.pl/138536500;0280-0.htm#tab=spec"), "138536500");
  assert.throws(() => parseProductRef("https://example.com/138536500"), /not a ceneo\.pl URL/);
  assert.throws(() => parseProductRef("https://www.ceneo.pl/Smartfony"), /not a Ceneo product page/);
  assert.throws(() => parseProductRef("iphone"), /neither/);
});

test("parseSearchHtml reads products from listing rows", () => {
  const products = parseSearchHtml(SEARCH_HTML, 10);
  assert.equal(products.length, 2);
  assert.deepEqual(products[0], {
    id: "138536500",
    name: "Apple iPhone 15 128GB Czarny",
    url: "https://www.ceneo.pl/138536500",
    price: 2649,
    shops: 26,
    rating: 4.9,
    reviews: 2344,
    params: ["Przekątna ekranu: 6,1 cala", "Pamięć wewnętrzna: 128 GB"],
  });
  // No data-productminprice: falls back to the visible price.
  assert.equal(products[1].name, "Apple iPhone 15 128GB  Żółty");
  assert.equal(products[1].price, 2647.99);
  assert.equal(parseSearchHtml(SEARCH_HTML, 1).length, 1);
  assert.deepEqual(parseSearchHtml("<html>no results</html>", 10), []);
});

test("parseProductHtml reads the summary and sorts offers by price", () => {
  const page = parseProductHtml(PRODUCT_HTML, "138536500", 10);
  assert.equal(page.name, "Apple iPhone 15 128GB Czarny");
  assert.equal(page.lowPrice, 2649);
  assert.equal(page.highPrice, 5039.7);
  assert.equal(page.offerCount, 26);
  assert.equal(page.rating, 4.85);
  assert.equal(page.ratingCount, 2344);
  assert.deepEqual(page.offers, [
    {
      shop: "abfoto.pl",
      price: 2649,
      title: "Apple iPhone 15 128 GB Czarny",
      shopRating: 4.7,
      shopReviews: 1754,
      freeDelivery: false,
      shipping: undefined,
    },
    {
      shop: "electro.pl",
      price: 2892.28,
      title: 'Smartfon APPLE iPhone 15 "Czarny"',
      shopRating: 1.7,
      shopReviews: 23,
      freeDelivery: true,
      shipping: "Wysyłka w 1 dzień",
    },
  ]);
  assert.equal(parseProductHtml(PRODUCT_HTML, "138536500", 1).offers.length, 1);
});

interface Route {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

function fakeFetch(routes: Record<string, Route>, seen: string[] = []) {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    const route = routes[url];
    if (!route) return new Response("not found", { status: 404 });
    return new Response(route.body ?? "", { status: route.status ?? 200, headers: route.headers });
  }) as typeof fetch;
}

function redirect(location: string): Route {
  return { status: 302, headers: { location } };
}

test("ceneo_search fetches the listing and formats results", async () => {
  const seen: string[] = [];
  const [search] = createCeneoTools({
    fetch: fakeFetch({ "https://www.ceneo.pl/;szukaj-iphone+15": { body: SEARCH_HTML } }, seen),
  });
  const text = textOf(await search.execute({ query: "iphone 15" }, toolContext()));
  assert.deepEqual(seen, ["https://www.ceneo.pl/;szukaj-iphone+15"]);
  assert.match(text, /1\. Apple iPhone 15 128GB Czarny\n {3}from 2649\.00 zł · 26 shops · rated 4\.9\/5 \(2344 reviews\)/);
  assert.match(text, /id 138536500 · https:\/\/www\.ceneo\.pl\/138536500/);
  assert.match(text, /ceneo_product/);
});

test("ceneo_search reports empty results and HTTP errors as text", async () => {
  const [search] = createCeneoTools({
    fetch: fakeFetch({
      "https://www.ceneo.pl/;szukaj-nothing": { body: "<html></html>" },
      "https://www.ceneo.pl/;szukaj-blocked": { status: 403, body: "" },
    }),
  });
  assert.equal(
    textOf(await search.execute({ query: "nothing" }, toolContext())),
    'No Ceneo products found for "nothing".',
  );
  assert.equal(
    textOf(await search.execute({ query: "blocked" }, toolContext())),
    "Ceneo search failed: Ceneo returned HTTP 403",
  );
});

test("ceneo_product lists offers and flags a partial list", async () => {
  const [, product] = createCeneoTools({
    fetch: fakeFetch({ "https://www.ceneo.pl/138536500": { body: PRODUCT_HTML } }),
  });
  const text = textOf(
    await product.execute({ product: "https://www.ceneo.pl/138536500#tab=reviews" }, toolContext()),
  );
  assert.match(text, /^Apple iPhone 15 128GB Czarny\nhttps:\/\/www\.ceneo\.pl\/138536500\n/);
  assert.match(text, /Price range: 2649\.00 zł – 5039\.70 zł/);
  assert.match(text, /cheapest first \(2 of 26; the full list is on the page\)/);
  assert.match(text, /1\. 2649\.00 zł — abfoto\.pl \(shop rated 4\.7\/5 \(1754\)\)/);
  assert.match(text, /2\. 2892\.28 zł — electro\.pl \(shop rated 1\.7\/5 \(23\), free delivery, Wysyłka w 1 dzień\)/);
});

test("ceneo_product reports unknown ids", async () => {
  const [, product] = createCeneoTools({
    fetch: fakeFetch({ "https://www.ceneo.pl/1": { status: 500, body: "" } }),
  });
  assert.equal(
    textOf(await product.execute({ product: "1" }, toolContext())),
    "No Ceneo product with id 1 (HTTP 500).",
  );
});

test("plugin registers both tools", async () => {
  const registered: string[] = [];
  const ctx: PluginContext = {
    pluginId: "ceneo",
    register: { provider() {}, tool: (tool) => registered.push(tool.name) },
    getConfig: <T,>() => ({}) as T,
    secrets: { get: async () => undefined },
    logger,
  };
  await createCeneoPlugin().activate(ctx);
  assert.deepEqual(registered, ["ceneo_search", "ceneo_product"]);
});

// The last offer is followed by more of the page: its reviews and footer say
// "Darmowa wysyłka" and "N opinii" too, and must not leak into that offer.
const PRODUCT_HTML_WITH_TAIL = `
<ul class="product-offers__list js_normal-offers">
<li class="product-offers__list__item js_productOfferGroupItem">
  <div class="product-offer__container js_product-offer" data-offer="1" data-shop="1">
  <div class="product-offer__logo"><a class='store-logo' href='#'><img src="a.jpg" alt="first.pl" /></a></div>
  <ul class="offer-extras"><li>Raty 0%</li></ul>
  <div class="product-offer__product__price">
    <span class="price-format nowrap"><span class="price"><span class="value">100</span><span class="penny">,00</span></span>zł</span>
  </div>
  </div>
</li>
<li class="product-offers__list__item js_productOfferGroupItem">
  <div class="product-offer__container js_product-offer" data-offer="2" data-shop="2">
  <div class="product-offer__logo"><a class='store-logo' href='#'><img src="b.jpg" alt="last.pl" /></a></div>
  <div class="product-offer__product__price">
    <span class="price-format nowrap"><span class="price"><span class="value">120</span><span class="penny">,00</span></span>zł</span>
  </div>
  </div>
</li>
</ul>
<section class="reviews">
  <span class="instock">Wysyłka w 24h</span>
  <p>Ocena 5,0 / 5 — 999 opinii. Darmowa wysyłka od 100 zł!</p>
</section>
`;

test("the last offer stops at the end of its item, not the page", () => {
  const page = parseProductHtml(PRODUCT_HTML_WITH_TAIL, "1", 10);
  assert.deepEqual(
    page.offers.map((offer) => offer.shop),
    ["first.pl", "last.pl"],
  );
  const last = page.offers[1];
  assert.equal(last.freeDelivery, false);
  assert.equal(last.shopReviews, undefined);
  assert.equal(last.shopRating, undefined);
  assert.equal(last.shipping, undefined);
});

test("the last offer is bounded by its list even without a closing </li>", () => {
  const html = PRODUCT_HTML_WITH_TAIL.replace(/<\/li>\n<\/ul>/, "\n</ul>");
  const last = parseProductHtml(html, "1", 10).offers[1];
  assert.equal(last.shop, "last.pl");
  assert.equal(last.freeDelivery, false);
  assert.equal(last.shopReviews, undefined);
});

test("an offer in both the promoted and the standard list is listed once", () => {
  const promoted = `
<ul class="product-offers__list js_bidding-offers">
<li class="product-offers__list__item js_productOfferGroupItem" data-ShopUrl="abfoto.pl" data-Price="2649.00">
  <div class="product-offer__container js_product-offer" data-offer="582280422" data-shop="382">
  <div class="product-offer__product__price"><span class="value">2 649</span><span class="penny">,00</span></div>
  </div>
</li>
<li class="product-offers__list__item js_productOfferGroupItem" data-ShopUrl="www.other.pl" data-Price="2700.00">
  <div class="product-offer__container js_product-offer" data-offer="777" data-shop="9">
  <div class="product-offer__product__price"><span class="value">2 700</span><span class="penny">,00</span></div>
  </div>
</li>
</ul>`;
  // The standard list repeats both: abfoto.pl by offer id, other.pl by shop and price.
  const standard = PRODUCT_HTML.replace(
    '<ul class="product-offers__list js_normal-offers">',
    `<ul class="product-offers__list js_normal-offers">
<li class="product-offers__list__item js_productOfferGroupItem">
  <div class="product-offer__logo"><img src="z.jpg" alt="Other.pl" /></div>
  <div class="product-offer__product__price"><span class="value">2 700</span><span class="penny">,00</span></div>
</li>`,
  );
  const page = parseProductHtml(promoted + standard, "138536500", 10);
  assert.deepEqual(
    page.offers.map((offer) => `${offer.shop} ${offer.price}`),
    ["abfoto.pl 2649", "www.other.pl 2700", "electro.pl 2892.28"],
  );
});

test("fetches follow redirects only within ceneo.pl", async () => {
  const seen: string[] = [];
  const [search, product] = createCeneoTools({
    fetch: fakeFetch(
      {
        "https://www.ceneo.pl/;szukaj-evil": redirect("https://evil.example/steal"),
        "https://www.ceneo.pl/;szukaj-plain": redirect("http://www.ceneo.pl/;szukaj-plain"),
        "https://www.ceneo.pl/;szukaj-loop": redirect("/;szukaj-loop"),
        "https://www.ceneo.pl/42": redirect("https://m.ceneo.pl/42"),
        "https://m.ceneo.pl/42": { body: PRODUCT_HTML },
      },
      seen,
    ),
  });
  assert.match(
    textOf(await search.execute({ query: "evil" }, toolContext())),
    /^Ceneo search failed: Ceneo redirected outside ceneo\.pl \(https:\/\/evil\.example\)$/,
  );
  assert.ok(!seen.some((url) => url.includes("evil.example")), "the foreign host is never requested");
  assert.match(
    textOf(await search.execute({ query: "plain" }, toolContext())),
    /redirected outside ceneo\.pl \(http:\/\/www\.ceneo\.pl\)/,
  );
  assert.equal(
    textOf(await search.execute({ query: "loop" }, toolContext())),
    "Ceneo search failed: Ceneo redirected too many times",
  );
  assert.match(textOf(await product.execute({ product: "42" }, toolContext())), /abfoto\.pl/);
});

test("fetches are capped in size", async () => {
  const big = "x".repeat(2048);
  const [search] = createCeneoTools({
    maxBytes: 1024,
    fetch: fakeFetch({
      "https://www.ceneo.pl/;szukaj-declared": { body: big, headers: { "content-length": "2048" } },
      "https://www.ceneo.pl/;szukaj-streamed": { body: big },
    }),
  });
  for (const query of ["declared", "streamed"]) {
    assert.equal(
      textOf(await search.execute({ query }, toolContext())),
      "Ceneo search failed: Ceneo page is larger than 1 KB",
    );
  }
});

test("fetches time out on their own, and the turn's abort still wins", async () => {
  const hang = (async (_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as typeof fetch;
  const [search] = createCeneoTools({ fetch: hang, timeoutMs: 20 });
  assert.equal(
    textOf(await search.execute({ query: "slow" }, toolContext())),
    "Ceneo search failed: Ceneo did not answer within 20ms",
  );

  const [slow] = createCeneoTools({ fetch: hang, timeoutMs: 60_000 });
  const controller = new AbortController();
  const running = slow.execute({ query: "slow" }, toolContext(controller.signal));
  controller.abort(new Error("turn cancelled"));
  await assert.rejects(running, /turn cancelled/);
});

test("ceneo_product turns a bad reference into a readable error", async () => {
  const seen: string[] = [];
  const [, product] = createCeneoTools({ fetch: fakeFetch({}, seen) });
  assert.equal(
    textOf(await product.execute({ product: "https://example.com/1" }, toolContext())),
    'Ceneo product lookup failed: "https://example.com/1" is not a ceneo.pl URL',
  );
  assert.equal(
    textOf(await product.execute({ product: "iphone" }, toolContext())),
    'Ceneo product lookup failed: "iphone" is neither a Ceneo product id nor a URL',
  );
  assert.deepEqual(seen, []);
});

test("ceneo_search rejects min_price above max_price without fetching", async () => {
  const seen: string[] = [];
  const [search] = createCeneoTools({ fetch: fakeFetch({}, seen) });
  assert.equal(
    textOf(await search.execute({ query: "iphone", min_price: 3000, max_price: 2000 }, toolContext())),
    "Ceneo search not run: min_price (3000) is above max_price (2000).",
  );
  assert.deepEqual(seen, []);
});

test("ceneo_search returns the product when Ceneo redirects an exact match to it", async () => {
  const [search] = createCeneoTools({
    fetch: fakeFetch({
      "https://www.ceneo.pl/;szukaj-iphone+15+czarny": redirect("/138536500"),
      "https://www.ceneo.pl/138536500": { body: PRODUCT_HTML },
    }),
  });
  const text = textOf(await search.execute({ query: "iphone 15 czarny" }, toolContext()));
  assert.match(
    text,
    /1\. Apple iPhone 15 128GB Czarny\n {3}from 2649\.00 zł · 26 shops · rated 4\.85\/5 \(2344 reviews\)\n {3}id 138536500 · https:\/\/www\.ceneo\.pl\/138536500/,
  );
  assert.doesNotMatch(text, /\n2\./);
});

test("productIdFromUrl recognises ceneo.pl product pages only", () => {
  assert.equal(productIdFromUrl("https://www.ceneo.pl/138536500"), "138536500");
  assert.equal(productIdFromUrl("https://www.ceneo.pl/138536500;0280-0.htm"), "138536500");
  assert.equal(productIdFromUrl("https://www.ceneo.pl/;szukaj-iphone"), undefined);
  assert.equal(productIdFromUrl("https://www.ceneo.pl/Smartfony"), undefined);
  assert.equal(productIdFromUrl("https://example.com/138536500"), undefined);
});

test("the prompt names Scout only when its tools are registered", () => {
  const without = ceneoPrompt(["ceneo_search", "ceneo_product", "web_search"]);
  assert.match(without, /ceneo_search and ceneo_product/);
  assert.doesNotMatch(without, /Scout|mcp__/);
  assert.equal(ceneoPrompt(), without);
  const withScout = ceneoPrompt(["ceneo_search", "mcp__scout__search_olx"]);
  assert.match(withScout, /instead of Scout \(mcp__scout__\* tools\)/);
  assert.match(withScout, /second-hand/);
});
