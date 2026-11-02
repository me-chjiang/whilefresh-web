import { CdpConnection, NetworkError } from "./cdp-connection.js";
import {
  buildContract,
  type ContractOperation,
  type ContractQuery,
} from "./contract.js";
import {
  RecipeErrorKind,
  type RecipeError,
  type RecipeSearchResult,
  type RecipeSource,
  type WebRecipe,
} from "./types.js";
import { parseContract } from "./xiachufang-parser.js";

type JsonObject = Record<string, unknown>;

const DEFAULT_BASE_URL = "https://api.lexmount.cn";
const SITE = "https://www.xiachufang.com";
const MAX_HTTP_BYTES = 4 * 1024 * 1024;
const VERIFICATION_TITLE = /验证|安全|拦截|captcha|denied|forbidden/iu;

const DEFAULT_TIMEOUTS: LexmountTimeouts = {
  httpTimeoutMs: 15_000,
  sessionReadyTimeoutMs: 40_000,
  stepTimeoutMs: 20_000,
  pageWaitTimeoutMs: 30_000,
  totalTimeoutMs: 90_000,
  cleanupTimeoutMs: 8_000,
  pollIntervalMs: 300,
};

const CREATE_BODY = {
  browser_mode: "normal",
  downloads: { enabled: true },
  enable_captcha: false,
  enable_lightmount_layout: true,
};

const SCRAPE_SCRIPT = `(async () => {
  const kind = '%1';
  const text = (root) => root ? (root.textContent || '').trim() : '';
  const image = (root) => { const i = root && root.querySelector('img');
    return i ? (i.currentSrc || i.src || i.getAttribute('data-src')) : null; };
  const titleEl = () => document.querySelector('h1.page-title[itemprop="name"]') || document.querySelector('h1.page-title');
  const waitFor = async (fn, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 150)); }
    return !!fn();
  };
  if (document.readyState !== 'complete')
    await new Promise((resolve) => window.addEventListener('load', resolve, {once: true}));
  if (kind === 'detail') await waitFor(titleEl, 8000);
  else await waitFor(() => document.querySelector('.normal-recipe-list .recipe'), 8000);
  await Promise.race([
    Promise.all([...document.images].map((img) => img.decode ? img.decode().catch(() => undefined) : undefined)),
    new Promise((r) => setTimeout(r, 3000))]);
  const diag = {title: document.title, host: location.host, path: location.pathname,
    list: !!document.querySelector('.normal-recipe-list')};
  if (kind === 'search') {
    const rows = [...document.querySelectorAll('.normal-recipe-list .recipe')].map((node) => {
      const links = [...node.querySelectorAll('a[href*="/recipe/"]')];
      const a = node.querySelector('.info .name a') || links.find((link) => text(link)) || links[0];
      const m = a && (a.getAttribute('href') || '').match(/\\/recipe\\/(\\d+)\\/?/);
      return m ? {name: text(a), url: \`/recipe/\${m[1]}/\`, cover: image(node.querySelector('.cover'))} : null;
    }).filter(Boolean);
    return {Recipe: rows, diag};
  }
  const title = titleEl();
  if (!title) return {diag};
  const materials = [...document.querySelectorAll('div.recipe-show > div.ings > table tr')].map((row) => ({
    name: text(row.querySelector('td.name')), unit: text(row.querySelector('td.unit'))})).filter((x) => x.name);
  const steps = [...document.querySelectorAll('div.steps > ol li')].map((node, n) => ({
    step: n + 1, desc: text(node.querySelector('p')), img: image(node)})).filter((x) => x.desc || x.img);
  return {Content: [{name: text(title), cover: image(document.querySelector('div.recipe-show > div.cover')),
    grade: text(document.querySelector('.recipe-show .stats .score .number')) || null,
    materials, steps, tip: text(document.querySelector('div.tip'))}], diag};
})()`;

const STATE_SCRIPT =
  "({href: location.href, ready: document.readyState, title: document.title})";

export interface LexmountCredentials {
  apiKey: string;
  projectId: string;
}

export interface LexmountTimeouts {
  httpTimeoutMs: number;
  sessionReadyTimeoutMs: number;
  stepTimeoutMs: number;
  pageWaitTimeoutMs: number;
  totalTimeoutMs: number;
  cleanupTimeoutMs: number;
  pollIntervalMs: number;
}

export interface LexmountSourceOptions {
  credentials: () => LexmountCredentials;
  baseUrl?: string;
  fetch?: typeof fetch;
  timeouts?: Partial<LexmountTimeouts>;
  pageSize?: number;
}

export class LexmountRecipeError extends Error implements RecipeError {
  readonly kind: RecipeErrorKind;
  readonly detail: string;
  readonly recipeError: RecipeError;

  constructor(error: RecipeError) {
    super(error.detail);
    this.name = "LexmountRecipeError";
    this.kind = error.kind;
    this.detail = error.detail;
    this.recipeError = error;
  }
}

interface HttpResult {
  status: number;
  body: string;
}

interface RecipeRequest {
  operation: ContractOperation;
  keyword: string;
  id: string;
  page: number;
}

interface PageState {
  href: URL;
  ready: string;
  title: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(kind: RecipeErrorKind, detail: string): LexmountRecipeError {
  return new LexmountRecipeError({ kind, detail });
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason;
  }
  const error = new Error("request cancelled");
  error.name = "AbortError";
  return error;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function findString(value: JsonObject, keys: readonly string[]): string {
  for (const key of keys) {
    const found = value[key];
    if (typeof found === "string" && found.length > 0) {
      return found;
    }
  }
  for (const nested of Object.values(value)) {
    if (isObject(nested)) {
      const found = findString(nested, keys);
      if (found.length > 0) {
        return found;
      }
    }
  }
  return "";
}

function statusOf(value: JsonObject): string {
  for (const key of ["status", "state"]) {
    const found = value[key];
    if (typeof found === "string") {
      return found.toLowerCase();
    }
  }
  for (const nested of Object.values(value)) {
    if (isObject(nested)) {
      const found = statusOf(nested);
      if (found.length > 0) {
        return found;
      }
    }
  }
  return "";
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      /timed out|timeout/iu.test(error.message))
  );
}

function pageState(value: unknown): PageState {
  const state = isObject(value) ? value : {};
  const hrefText =
    typeof state.href === "string" ? state.href : "about:blank";
  return {
    href: new URL(hrefText),
    ready: typeof state.ready === "string" ? state.ready : "",
    title: typeof state.title === "string" ? state.title : "",
  };
}

export class LexmountRecipeSource implements RecipeSource {
  private readonly credentials: () => LexmountCredentials;
  private readonly baseUrl: string;
  private readonly requestFetch: typeof fetch;
  private readonly timeouts: LexmountTimeouts;
  private readonly pageSize: number;

  constructor(options: LexmountSourceOptions) {
    this.credentials = options.credentials;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
    this.requestFetch = options.fetch ?? fetch;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.pageSize = options.pageSize ?? 20;
  }

  isConfigured(): boolean {
    const credentials = this.credentials();
    return (
      credentials.apiKey.length > 0 && credentials.projectId.length > 0
    );
  }

  async search(
    keyword: string,
    page: number,
    signal: AbortSignal,
  ): Promise<RecipeSearchResult> {
    const credentials = this.requireCredentials();
    if (
      keyword.trim().length === 0 ||
      keyword.length > 200 ||
      page < 1
    ) {
      throw failure(
        RecipeErrorKind.InvalidQuery,
        "keyword must be 1-200 characters",
      );
    }
    return (await this.run(
      {
        operation: "search",
        keyword: keyword.trim(),
        id: "",
        page,
      },
      credentials,
      signal,
    )) as RecipeSearchResult;
  }

  async detail(id: string, signal: AbortSignal): Promise<WebRecipe> {
    const credentials = this.requireCredentials();
    if (!/^\d{1,20}$/u.test(id)) {
      throw failure(
        RecipeErrorKind.InvalidQuery,
        "id must contain 1-20 digits",
      );
    }
    return (await this.run(
      { operation: "detail", keyword: "", id, page: 1 },
      credentials,
      signal,
    )) as WebRecipe;
  }

  private requireCredentials(): LexmountCredentials {
    const credentials = this.credentials();
    if (
      credentials.apiKey.length === 0 ||
      credentials.projectId.length === 0
    ) {
      throw failure(
        RecipeErrorKind.NotConfigured,
        "no Lexmount credentials",
      );
    }
    return credentials;
  }

  private async run(
    request: RecipeRequest,
    credentials: LexmountCredentials,
    callerSignal: AbortSignal,
  ): Promise<RecipeSearchResult | WebRecipe> {
    if (callerSignal.aborted) {
      throw abortReason(callerSignal);
    }
    const startedAt = performance.now();
    const operationController = new AbortController();
    let stopped: Error | null = null;
    let creating = false;
    let createCleanupTimer:
      | ReturnType<typeof setTimeout>
      | undefined;
    let createController = new AbortController();
    let sessionId = "";

    const stop = (reason: Error): void => {
      if (stopped) {
        return;
      }
      stopped = reason;
      if (creating) {
        createCleanupTimer = setTimeout(() => {
          createController.abort(reason);
        }, this.timeouts.cleanupTimeoutMs);
      } else {
        operationController.abort(reason);
      }
    };
    const onCallerAbort = (): void => {
      stop(abortReason(callerSignal));
    };
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    if (callerSignal.aborted) {
      onCallerAbort();
    }
    const totalTimer = setTimeout(() => {
      stop(failure(RecipeErrorKind.Timeout, "request timed out"));
    }, this.timeouts.totalTimeoutMs);

    try {
      creating = true;
      createController = new AbortController();
      const createTimer = setTimeout(() => {
        stop(
          failure(
            RecipeErrorKind.Timeout,
            "Lexmount request timed out",
          ),
        );
      }, this.timeouts.httpTimeoutMs);
      let created: JsonObject;
      try {
        created = await this.requestJson(
          "POST",
          "/instance/v2",
          JSON.stringify(CREATE_BODY),
          credentials,
          createController.signal,
          0,
        );
      } catch (error) {
        if (stopped) {
          throw stopped;
        }
        throw error;
      } finally {
        clearTimeout(createTimer);
        clearTimeout(createCleanupTimer);
        creating = false;
      }

      sessionId = findString(created, [
        "session_id",
        "sessionId",
        "instance_id",
        "id",
      ]);
      if (stopped) {
        throw stopped;
      }

      if (sessionId.length === 0) {
        throw failure(
          RecipeErrorKind.Unavailable,
          "Lexmount browser did not return a session",
        );
      }

      const signal = operationController.signal;
      const sessionStarted = performance.now();
      for (;;) {
        const state = await this.requestJson(
          "POST",
          "/instance/session",
          JSON.stringify({ session_id: sessionId }),
          credentials,
          signal,
        );
        const status = statusOf(state);
        if (
          status === "active" ||
          status === "ready" ||
          status === "running"
        ) {
          break;
        }
        if (
          status === "failed" ||
          status === "error" ||
          status === "stopped" ||
          status === "terminated"
        ) {
          throw failure(
            RecipeErrorKind.Unavailable,
            "Lexmount browser session failed",
          );
        }
        if (
          performance.now() - sessionStarted >
          this.timeouts.sessionReadyTimeoutMs
        ) {
          throw failure(
            RecipeErrorKind.Timeout,
            "Lexmount browser session did not become ready",
          );
        }
        await sleep(this.timeouts.pollIntervalMs, signal);
      }

      const versionUrl = this.url("/json/version");
      versionUrl.searchParams.set("session_id", sessionId);
      const version = await this.requestJson(
        "GET",
        `${versionUrl.pathname}${versionUrl.search}`,
        undefined,
        credentials,
        signal,
      );
      let socketUrl =
        typeof version.webSocketDebuggerUrlTransformed === "string"
          ? version.webSocketDebuggerUrlTransformed
          : "";
      if (socketUrl.length === 0) {
        socketUrl =
          typeof version.webSocketDebuggerUrl === "string"
            ? version.webSocketDebuggerUrl
            : "";
      }
      if (socketUrl.length === 0) {
        socketUrl =
          typeof version.websocketDebuggerUrl === "string"
            ? version.websocketDebuggerUrl
            : "";
      }
      if (socketUrl.length === 0) {
        throw failure(
          RecipeErrorKind.Unavailable,
          "Lexmount browser websocket URL missing",
        );
      }

      const scraped = await this.readPage(
        socketUrl,
        request,
        signal,
      );
      const query: ContractQuery = {
        keyword: request.keyword,
        id: request.id,
        page: request.page,
        pageSize: this.pageSize,
        provider: "lexmount",
        elapsedMs: performance.now() - startedAt,
      };
      let contract: unknown;
      try {
        contract = buildContract(request.operation, query, scraped);
      } catch (error) {
        throw failure(
          RecipeErrorKind.BadResponse,
          error instanceof Error ? error.message : "malformed contract",
        );
      }
      const parsed = parseContract(contract);
      if (!parsed.result) {
        throw new LexmountRecipeError(parsed.error);
      }
      return parsed.result;
    } catch (error) {
      if (stopped) {
        throw stopped;
      }
      if (error instanceof LexmountRecipeError) {
        throw error;
      }
      if (operationController.signal.aborted) {
        throw abortReason(operationController.signal);
      }
      if (isTimeoutError(error)) {
        throw failure(
          RecipeErrorKind.Timeout,
          error instanceof Error ? error.message : "request timed out",
        );
      }
      throw failure(
        RecipeErrorKind.NetworkError,
        error instanceof Error
          ? `Lexmount request failed: ${error.message}`
          : "Lexmount request failed",
      );
    } finally {
      clearTimeout(totalTimer);
      clearTimeout(createCleanupTimer);
      callerSignal.removeEventListener("abort", onCallerAbort);
      if (sessionId.length > 0) {
        await this.cleanup(sessionId, credentials);
      }
    }
  }

  private url(path: string): URL {
    return new URL(path, `${this.baseUrl}/`);
  }

  private headers(credentials: LexmountCredentials): HeadersInit {
    return {
      "Content-Type": "application/json",
      "x-api-key": credentials.apiKey,
      "x-project-id": credentials.projectId,
    };
  }

  private async requestJson(
    method: string,
    path: string,
    body: string | undefined,
    credentials: LexmountCredentials,
    signal: AbortSignal,
    timeoutMs = this.timeouts.httpTimeoutMs,
  ): Promise<JsonObject> {
    const result = await this.request(
      method,
      path,
      body,
      credentials,
      signal,
      timeoutMs,
    );
    const contentType = result.status;
    if (contentType === 401 || contentType === 403) {
      throw failure(
        RecipeErrorKind.AuthFailed,
        `Lexmount HTTP ${contentType}`,
      );
    }
    if (contentType < 200 || contentType >= 300) {
      throw failure(
        RecipeErrorKind.Unavailable,
        `Lexmount HTTP ${contentType}`,
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(result.body);
    } catch {
      throw failure(
        RecipeErrorKind.BadResponse,
        "Lexmount returned invalid JSON",
      );
    }
    if (!isObject(decoded)) {
      throw failure(
        RecipeErrorKind.BadResponse,
        "Lexmount returned invalid JSON",
      );
    }
    return decoded;
  }

  private async request(
    method: string,
    path: string,
    body: string | undefined,
    credentials: LexmountCredentials,
    parentSignal: AbortSignal,
    timeoutMs: number,
  ): Promise<HttpResult> {
    if (parentSignal.aborted) {
      throw abortReason(parentSignal);
    }
    const controller = new AbortController();
    let timedOut = false;
    const onParentAbort = (): void => {
      controller.abort(abortReason(parentSignal));
    };
    parentSignal.addEventListener("abort", onParentAbort, {
      once: true,
    });
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, timeoutMs)
        : undefined;

    try {
      const response = await this.requestFetch(this.url(path).toString(), {
        method,
        headers: this.headers(credentials),
        body,
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        return { status: response.status, body: "" };
      }
      if (response.status < 200 || response.status >= 300) {
        return { status: response.status, body: "" };
      }
      const contentLength = Number(
        response.headers.get("content-length") ?? "0",
      );
      if (
        Number.isFinite(contentLength) &&
        contentLength > MAX_HTTP_BYTES
      ) {
        throw failure(
          RecipeErrorKind.BadResponse,
          "Lexmount response exceeds 4 MiB",
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_HTTP_BYTES) {
        throw failure(
          RecipeErrorKind.BadResponse,
          "Lexmount response exceeds 4 MiB",
        );
      }
      return {
        status: response.status,
        body: new TextDecoder().decode(bytes),
      };
    } catch (error) {
      if (parentSignal.aborted) {
        throw abortReason(parentSignal);
      }
      if (timedOut || isTimeoutError(error)) {
        throw failure(
          RecipeErrorKind.Timeout,
          "Lexmount request timed out",
        );
      }
      if (error instanceof LexmountRecipeError) {
        throw error;
      }
      const detail =
        error instanceof Error ? `: ${error.message}` : "";
      throw failure(
        RecipeErrorKind.NetworkError,
        `Lexmount request failed${detail}`,
      );
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      parentSignal.removeEventListener("abort", onParentAbort);
    }
  }

  private async readPage(
    socketUrl: string,
    request: RecipeRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    const connection = new CdpConnection(socketUrl, {
      stepTimeoutMs: this.timeouts.stepTimeoutMs,
    });
    const onAbort = (): void => {
      connection.close();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const openController = new AbortController();
      const onOpenAbort = (): void => {
        openController.abort(abortReason(signal));
      };
      signal.addEventListener("abort", onOpenAbort, { once: true });
      const openTimer = setTimeout(() => {
        openController.abort(
          failure(RecipeErrorKind.Timeout, "step timed out"),
        );
      }, this.timeouts.stepTimeoutMs);
      try {
        await connection.open(openController.signal);
      } finally {
        clearTimeout(openTimer);
        signal.removeEventListener("abort", onOpenAbort);
      }

      const targets = await connection.send("Target.getTargets");
      const targetInfos = Array.isArray(targets.targetInfos)
        ? targets.targetInfos
        : [];
      let targetId = "";
      for (const value of targetInfos) {
        if (!isObject(value)) {
          continue;
        }
        if (value.type === "page") {
          targetId =
            typeof value.targetId === "string" ? value.targetId : "";
          break;
        }
      }
      if (targetId.length === 0 && targetInfos[0] !== undefined) {
        const first = targetInfos[0];
        targetId =
          isObject(first) && typeof first.targetId === "string"
            ? first.targetId
            : "";
      }
      if (targetId.length === 0) {
        throw failure(
          RecipeErrorKind.Unavailable,
          "Lexmount browser page target missing",
        );
      }

      const attached = await connection.send(
        "Target.attachToTarget",
        { targetId, flatten: true },
      );
      const cdpSession =
        typeof attached.sessionId === "string"
          ? attached.sessionId
          : "";
      await connection.send("Page.enable", {}, cdpSession);
      await connection.send("Runtime.enable", {}, cdpSession);
      let navigation: JsonObject;
      try {
        navigation = await connection.send(
          "Page.navigate",
          { url: this.targetUrl(request) },
          cdpSession,
        );
      } catch (error) {
        if (signal.aborted) {
          throw abortReason(signal);
        }
        if (isTimeoutError(error)) {
          throw failure(
            RecipeErrorKind.Timeout,
            error instanceof Error ? error.message : "step timed out",
          );
        }
        throw failure(
          RecipeErrorKind.NetworkError,
          `navigation failed: ${
            error instanceof Error ? error.message.slice(0, 80) : ""
          }`,
        );
      }
      if (
        typeof navigation.errorText === "string" &&
        navigation.errorText.length > 0
      ) {
        throw failure(
          RecipeErrorKind.NetworkError,
          `navigation failed: ${navigation.errorText.slice(0, 80)}`,
        );
      }

      const targetPath =
        request.operation === "search"
          ? "/search/"
          : `/recipe/${request.id}/`;
      const pageStarted = performance.now();
      let lastPath = "";
      let lastTitle = "";
      let stablePolls = 0;
      for (;;) {
        const evaluated = await connection.send(
          "Runtime.evaluate",
          {
            expression: STATE_SCRIPT,
            returnByValue: true,
          },
          cdpSession,
        );
        const remote = isObject(evaluated.result)
          ? evaluated.result
          : {};
        const state = pageState(remote.value);
        lastPath = `${state.href.host}${state.href.pathname}`;
        lastTitle = state.title;
        const http =
          state.href.protocol === "http:" ||
          state.href.protocol === "https:";
        if (state.ready === "complete" && http) {
          if (state.href.pathname === targetPath) {
            break;
          }
          stablePolls += 1;
          if (stablePolls >= 2) {
            break;
          }
        } else {
          stablePolls = 0;
        }
        if (
          performance.now() - pageStarted >
          this.timeouts.pageWaitTimeoutMs
        ) {
          throw failure(
            RecipeErrorKind.Timeout,
            `page did not load (${lastPath}, title="${lastTitle.slice(0, 60)}")`,
          );
        }
        await sleep(this.timeouts.pollIntervalMs, signal);
      }

      const scraped = await connection.send(
        "Runtime.evaluate",
        {
          expression: SCRAPE_SCRIPT.replace("%1", request.operation),
          returnByValue: true,
          awaitPromise: true,
        },
        cdpSession,
      );
      if (
        isObject(scraped.exceptionDetails) &&
        Object.keys(scraped.exceptionDetails).length > 0
      ) {
        throw failure(
          RecipeErrorKind.Unavailable,
          "page script failed",
        );
      }
      const result = isObject(scraped.result) ? scraped.result : {};
      return result.value;
    } catch (error) {
      if (signal.aborted) {
        throw abortReason(signal);
      }
      if (error instanceof LexmountRecipeError) {
        throw error;
      }
      if (error instanceof NetworkError) {
        throw failure(
          RecipeErrorKind.NetworkError,
          `browser connection lost: ${error.message}`,
        );
      }
      if (isTimeoutError(error)) {
        throw failure(
          RecipeErrorKind.Timeout,
          error instanceof Error ? error.message : "step timed out",
        );
      }
      throw failure(
        RecipeErrorKind.Unavailable,
        error instanceof Error
          ? `browser command failed: ${error.message.slice(0, 120)}`
          : "browser command failed",
      );
    } finally {
      signal.removeEventListener("abort", onAbort);
      connection.close();
    }
  }

  private targetUrl(request: RecipeRequest): string {
    if (request.operation === "detail") {
      return `${SITE}/recipe/${request.id}/`;
    }
    return `${SITE}/search/?keyword=${encodeURIComponent(request.keyword)}&cat=1001&page=${request.page}`;
  }

  private async cleanup(
    sessionId: string,
    credentials: LexmountCredentials,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeouts.cleanupTimeoutMs);
    try {
      await this.requestFetch(this.url("/instance").toString(), {
        method: "DELETE",
        headers: this.headers(credentials),
        body: JSON.stringify({ session_id: sessionId }),
        signal: controller.signal,
      });
    } catch {
      // Cleanup is best effort; the original outcome is already decided.
    } finally {
      clearTimeout(timer);
    }
  }
}
