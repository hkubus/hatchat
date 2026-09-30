import { allowedPrivateHosts, assertPublicUrl, resolvePublicHost } from "@hat/net-guard";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";
import { startEgressProxy, type EgressProxy } from "./egress.js";

export interface PageSnapshot {
  title: string;
  url: string;
  text: string;
  links: { text: string; href: string }[];
}

/**
 * The browser surface the tool needs. Kept as an interface so tests can drive
 * the tool dispatch and formatting without launching Chromium.
 */
export interface BrowserController {
  open(sessionId: string, url: string): Promise<PageSnapshot>;
  read(sessionId: string): Promise<PageSnapshot>;
  click(sessionId: string, selector: string): Promise<PageSnapshot>;
  type(sessionId: string, selector: string, text: string): Promise<PageSnapshot>;
  press(sessionId: string, key: string, selector?: string): Promise<PageSnapshot>;
  screenshot(sessionId: string): Promise<Buffer>;
  back(sessionId: string): Promise<PageSnapshot>;
  close(sessionId: string): Promise<void>;
  dispose(): Promise<void>;
}

export interface BrowserManagerOptions {
  executablePath?: string;
  headless?: boolean;
  idleTimeoutMs: number;
  navigationTimeoutMs: number;
  maxTextChars: number;
  maxLinks: number;
  /**
   * Host names the browser may reach although they are private (your own
   * services). Defaults to `HAT_ALLOW_PRIVATE_HOSTS`; see `@hat/net-guard`.
   */
  allowPrivateHosts?: readonly string[];
}

interface LiveSession {
  context: BrowserContext;
  page: Page;
  timer: NodeJS.Timeout;
}

const MAX_LINK_TEXT = 120;

/** One shared Chromium; one isolated context/page per conversation. */
export class BrowserManager implements BrowserController {
  private browser?: Browser;
  private launching?: Promise<Browser>;
  private readonly sessions = new Map<string, LiveSession>();
  /** Every connection the browser makes goes through this (see `startEgressProxy`). */
  private proxy?: Promise<EgressProxy>;

  constructor(private readonly options: BrowserManagerOptions) {}

  private allowHosts(): readonly string[] {
    return this.options.allowPrivateHosts ?? allowedPrivateHosts();
  }

  private async browserInstance(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.proxy ??= startEgressProxy((host) => resolvePublicHost(host, { allowHosts: this.allowHosts() }));
    const proxy = this.proxy;
    this.launching ??= proxy
      .then(({ url }) =>
        chromium.launch({
          executablePath: this.options.executablePath || undefined,
          headless: this.options.headless,
          args: ["--no-sandbox", "--disable-dev-shm-usage"],
          // Playwright also sends loopback traffic through the proxy, which
          // Chromium would otherwise let bypass it.
          proxy: { server: url },
        }),
      )
      .then((browser) => {
        this.browser = browser;
        browser.on("disconnected", () => {
          this.browser = undefined;
          this.launching = undefined;
          this.sessions.clear();
        });
        return browser;
      })
      .catch((error: unknown) => {
        this.launching = undefined;
        // A proxy that never started is not worth keeping for the next try.
        if (this.proxy === proxy) void proxy.catch(() => (this.proxy = undefined));
        throw error;
      });
    return this.launching;
  }

  private async session(sessionId: string): Promise<LiveSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.touch(sessionId, existing);
      return existing;
    }
    const browser = await this.browserInstance();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.setDefaultTimeout(this.options.navigationTimeoutMs);
    const live: LiveSession = {
      context,
      page,
      // Placeholder replaced immediately by touch(); keeps the type non-optional.
      timer: setTimeout(() => {}, 0),
    };
    this.sessions.set(sessionId, live);
    this.touch(sessionId, live);
    return live;
  }

  private touch(sessionId: string, session: LiveSession): void {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      void this.close(sessionId);
    }, this.options.idleTimeoutMs);
    session.timer.unref?.();
  }

  private async settle(page: Page): Promise<void> {
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
  }

  private async snapshot(page: Page): Promise<PageSnapshot> {
    const title = await page.title().catch(() => "");
    const text = (await page.innerText("body").catch(() => ""))
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, this.options.maxTextChars);
    const seen = new Set<string>();
    const links: { text: string; href: string }[] = [];
    const found = await page
      .$$eval("a[href]", (anchors) =>
        anchors.map((anchor) => ({
          text: (anchor.textContent ?? "").replace(/\s+/g, " ").trim(),
          href: (anchor as HTMLAnchorElement).href,
        })),
      )
      .catch(() => [] as { text: string; href: string }[]);
    for (const link of found) {
      if (!/^https?:/i.test(link.href) || !link.text) continue;
      if (seen.has(link.href)) continue;
      seen.add(link.href);
      links.push({ text: link.text.slice(0, MAX_LINK_TEXT), href: link.href });
      if (links.length >= this.options.maxLinks) break;
    }
    return { title, url: page.url(), text, links };
  }

  async open(sessionId: string, url: string): Promise<PageSnapshot> {
    // The proxy would refuse it too; checked here for a clearer error.
    try {
      await assertPublicUrl(url, { allowHosts: this.allowHosts() });
    } catch (error) {
      throw new Error(`refusing to open ${url}: ${(error as Error).message}`);
    }
    const { page } = await this.session(sessionId);
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: this.options.navigationTimeoutMs,
    });
    await this.settle(page);
    return this.snapshot(page);
  }

  async read(sessionId: string): Promise<PageSnapshot> {
    const { page } = await this.session(sessionId);
    return this.snapshot(page);
  }

  async click(sessionId: string, selector: string): Promise<PageSnapshot> {
    const { page } = await this.session(sessionId);
    await page.click(selector);
    await this.settle(page);
    return this.snapshot(page);
  }

  async type(sessionId: string, selector: string, text: string): Promise<PageSnapshot> {
    const { page } = await this.session(sessionId);
    await page.fill(selector, text);
    return this.snapshot(page);
  }

  async press(sessionId: string, key: string, selector?: string): Promise<PageSnapshot> {
    const { page } = await this.session(sessionId);
    if (selector) {
      await page.locator(selector).press(key);
    } else {
      await page.keyboard.press(key);
    }
    await this.settle(page);
    return this.snapshot(page);
  }

  async screenshot(sessionId: string): Promise<Buffer> {
    const { page } = await this.session(sessionId);
    return page.screenshot({ fullPage: true });
  }

  async back(sessionId: string): Promise<PageSnapshot> {
    const { page } = await this.session(sessionId);
    await page.goBack({ waitUntil: "domcontentloaded", timeout: this.options.navigationTimeoutMs });
    await this.settle(page);
    return this.snapshot(page);
  }

  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    clearTimeout(session.timer);
    await session.context.close().catch(() => {});
  }

  async dispose(): Promise<void> {
    for (const sessionId of [...this.sessions.keys()]) {
      await this.close(sessionId);
    }
    const browser = this.browser;
    const proxy = this.proxy;
    this.browser = undefined;
    this.launching = undefined;
    this.proxy = undefined;
    await browser?.close().catch(() => {});
    await (await proxy?.catch(() => undefined))?.close();
  }
}
