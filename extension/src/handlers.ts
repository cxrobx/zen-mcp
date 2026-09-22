import {
  type ClearCookiesParams,
  type ClearCookiesResult,
  type ClearSnapshotParams,
  type ClosePageParams,
  type CookieEntry,
  type DragByLocatorParams,
  type DragParams,
  type EvaluateScriptParams,
  type EvaluateScriptResult,
  type FillByLocatorParams,
  type FillFormParams,
  type GetPageParams,
  type GetPageResult,
  type PagesListParams,
  type FillParams,
  type FirefoxContainer,
  type GetCookiesParams,
  type GetCookiesResult,
  type GetPageTextParams,
  type GetPageTextResult,
  type InfoGetResult,
  type InteractionResult,
  type LocatorParams,
  type LocatorSpec,
  Methods,
  type NavigateHistoryParams,
  type NavigatePageParams,
  type NewPageParams,
  type NewPageResult,
  type PageInfo,
  type PressKeyParams,
  PROTOCOL_VERSION,
  type ReadPageParams,
  type ReadPageResult,
  type ResolveUidResult,
  type ScreenshotPageParams,
  type ScreenshotPageResult,
  type SelectOptionByLocatorParams,
  type SelectOptionResult,
  type SelectPageParams,
  type SetCookiesParams,
  type SetCookiesResult,
  type ScrollParams,
  type ScrollResult,
  type SnapshotUidEntry,
  type StorageClearParams,
  type StorageClearResult,
  type StorageGetParams,
  type StorageGetResult,
  type StorageSetParams,
  type StorageSetResult,
  type TabIdResult,
  type TakeSnapshotParams,
  type TakeSnapshotResult,
  type TypeByLocatorParams,
  type UidActionParams,
} from "@zen-mcp/shared";

export type Handler = (params: unknown) => Promise<unknown>;

const EXECUTE_SCRIPT_TIMEOUT_MS = 15_000;
const DEFAULT_LOCATOR_TIMEOUT_MS = 5_000;
const POLL_MS = 200;
const PAGE_TEXT_MAX_CHARS = 200_000;

async function buildContainerLookup(): Promise<Map<string, string>> {
  const identities = await browser.contextualIdentities.query({});
  const map = new Map<string, string>();
  for (const id of identities) {
    map.set(id.cookieStoreId, id.name);
  }
  return map;
}

/**
 * A window a CONTAINER tab may legally be created in.
 *
 * `tabs.create` with no `windowId` inherits the last-focused window, and a non-private
 * cookieStoreId is illegal in a private one - Firefox rejects the whole call with
 * "Illegal to set non-private cookieStoreId in a private window". An extension without
 * incognito access cannot see private windows at all, so it cannot even report which
 * window is in the way; from here it just looks like every container tab-open is broken
 * while the user has a private window focused.
 *
 * Every window this CAN see is therefore a legal home. Prefer the focused one so a tab
 * still lands where the user is working whenever that window is an ordinary one.
 */
async function containerWindowId(): Promise<number | null> {
  try {
    const windows = await browser.windows.getAll({});
    const usable = windows.filter((w) => w.incognito !== true && w.type === "normal" && typeof w.id === "number");
    return (usable.find((w) => w.focused) ?? usable[0])?.id ?? null;
  } catch {
    return null;
  }
}

function tabToPageInfo(
  tab: browser.tabs.Tab,
  names: Map<string, string>,
  inActiveWorkspace: boolean,
): PageInfo {
  const cookieStoreId = tab.cookieStoreId ?? "firefox-default";
  return {
    tabId: tab.id ?? -1,
    windowId: tab.windowId ?? -1,
    index: tab.index ?? -1,
    url: tab.url ?? "",
    title: tab.title ?? "",
    active: !!tab.active,
    cookieStoreId,
    containerName: names.get(cookieStoreId) ?? null,
    inActiveWorkspace,
    discarded: !!(tab as { discarded?: boolean }).discarded,
  };
}

// --- Tabs in other Zen workspaces --------------------------------------------------------
// Zen builds gBrowser.tabs from the ACTIVE space's tab strip only, and browser.tabs.query()
// iterates gBrowser.tabs, so a tab in another space never appears in a query - it is not
// `hidden`, it is simply not enumerated. It is still addressable: the parent-side tab tracker
// resolves ids from a plain map with no workspace filter, so tabs.get / scripting /
// captureTab / tabs.update all reach it by id. Ids are dense sequential integers, so the
// live set is recoverable by probing every id up to the highest one seen. tabs.onCreated
// keeps that horizon current and, as a side effect, forces an id onto every tab the moment
// it is created in ANY space (session restore included) - which is what makes it probe-able.
const TAB_ID_HORIZON_KEY = "tabIdHorizon";
const TAB_ID_PROBE_MARGIN = 16;
let tabIdHorizon = 0;

function noteTabId(tabId: number | undefined): void {
  if (typeof tabId !== "number" || !(tabId > tabIdHorizon)) return;
  tabIdHorizon = tabId;
  const store = snapshotStorage();
  if (store) void store.set({ [TAB_ID_HORIZON_KEY]: tabId }).catch(() => undefined);
}

async function loadTabIdHorizon(): Promise<void> {
  const store = snapshotStorage();
  if (!store) return;
  try {
    const got = await store.get(TAB_ID_HORIZON_KEY);
    const stored = got[TAB_ID_HORIZON_KEY];
    if (typeof stored === "number" && stored > tabIdHorizon) tabIdHorizon = stored;
  } catch {
    // Best effort: the probe still covers every id the visible set reaches.
  }
}

/** Tabs reachable by id but absent from tabs.query(): the other Zen workspaces' tabs. */
async function probeHiddenWorkspaceTabs(visible: browser.tabs.Tab[]): Promise<browser.tabs.Tab[]> {
  const seen = new Set<number>();
  for (const tab of visible) {
    if (typeof tab.id !== "number") continue;
    seen.add(tab.id);
    noteTabId(tab.id);
  }
  const ids: number[] = [];
  for (let id = 1; id <= tabIdHorizon + TAB_ID_PROBE_MARGIN; id++) {
    if (!seen.has(id)) ids.push(id);
  }
  const settled = await Promise.allSettled(ids.map((id) => browser.tabs.get(id)));
  const hidden: browser.tabs.Tab[] = [];
  for (const entry of settled) {
    if (entry.status !== "fulfilled" || typeof entry.value.id !== "number") continue;
    hidden.push(entry.value);
    noteTabId(entry.value.id);
  }
  return hidden;
}

/**
 * Selecting a tab in another space makes Zen switch the space asynchronously and select the
 * tab afterwards, so tabs.update resolves before the tab is active. Wait for it so the
 * caller's next list_pages already shows the new space.
 */
async function waitForTabActive(tabId: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tab = await browser.tabs.get(tabId);
      if (tab.active) return true;
    } catch {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }
  return value;
}

const snapshotCache = new Map<number, Map<string, SnapshotUidEntry>>();
let nextSnapshotId = 1;

interface SnapshotStorageArea {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

interface ActionFeedbackInput {
  url: string;
  title: string;
}

function snapshotStorage(): SnapshotStorageArea | null {
  const storage = browser.storage as unknown as { session?: SnapshotStorageArea };
  return storage.session ?? null;
}

function snapshotStorageKey(tabId: number): string {
  return `snapshot:${tabId}`;
}

async function persistSnapshotCache(
  tabId: number,
  map: Map<string, SnapshotUidEntry>,
): Promise<void> {
  const store = snapshotStorage();
  if (!store) return;
  await store.set({ [snapshotStorageKey(tabId)]: Array.from(map.values()) });
}

async function loadSnapshotCache(tabId: number): Promise<Map<string, SnapshotUidEntry> | null> {
  const cached = snapshotCache.get(tabId);
  if (cached) return cached;
  const store = snapshotStorage();
  if (!store) return null;
  const data = await store.get(snapshotStorageKey(tabId));
  const raw = data[snapshotStorageKey(tabId)];
  if (!Array.isArray(raw)) return null;
  const map = new Map<string, SnapshotUidEntry>();
  for (const item of raw) {
    const entry = item as Partial<SnapshotUidEntry>;
    if (typeof entry.uid === "string" && typeof entry.css === "string") {
      map.set(entry.uid, {
        uid: entry.uid,
        css: entry.css,
        ...(typeof entry.xpath === "string" ? { xpath: entry.xpath } : {}),
        ...(typeof entry.frameId === "number" ? { frameId: entry.frameId } : {}),
      });
    }
  }
  snapshotCache.set(tabId, map);
  return map;
}

async function clearSnapshotCache(tabId: number): Promise<void> {
  snapshotCache.delete(tabId);
  const store = snapshotStorage();
  if (store) await store.remove(snapshotStorageKey(tabId));
}

function clearTopFrameSnapshot(details: browser.webNavigation._OnCommittedDetails): void {
  if (details.frameId === 0) void clearSnapshotCache(details.tabId);
}

browser.webNavigation.onCommitted.addListener(clearTopFrameSnapshot);
browser.webNavigation.onHistoryStateUpdated.addListener(clearTopFrameSnapshot);
browser.webNavigation.onReferenceFragmentUpdated.addListener(clearTopFrameSnapshot);
browser.tabs.onRemoved.addListener((tabId) => void clearSnapshotCache(tabId));
browser.tabs.onCreated.addListener((tab) => noteTabId(tab.id));
void loadTabIdHorizon();

function isPrivilegedUrl(url: string): boolean {
  return (
    url.startsWith("about:") ||
    url.startsWith("view-source:") ||
    url.startsWith("moz-extension:") ||
    url.startsWith("chrome:") ||
    url.startsWith("resource:") ||
    url.startsWith("https://addons.mozilla.org/")
  );
}

async function scriptError(tabId: number, err: unknown): Promise<Error> {
  const message = err instanceof Error ? err.message : String(err);
  let url = "";
  try {
    url = (await browser.tabs.get(tabId)).url ?? "";
  } catch {
    // ignore
  }
  if (isPrivilegedUrl(url)) {
    return new Error(
      `this page type can't be scripted by extensions - not retryable (${url})`,
    );
  }
  return new Error(message);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function ensureSnapshotInjected(tabId: number, allFrames: boolean): Promise<void> {
  try {
    await withTimeout(
      browser.scripting.executeScript({
        target: allFrames ? { tabId, allFrames: true } : { tabId },
        files: ["snapshot/inject.js"],
        world: "MAIN" as browser.scripting.ExecutionWorld,
      }),
      EXECUTE_SCRIPT_TIMEOUT_MS,
      `snapshot injection did not finish within ${EXECUTE_SCRIPT_TIMEOUT_MS}ms`,
    );
  } catch (err) {
    throw await scriptError(tabId, err);
  }
}

async function ensureEvaluatorInjected(tabId: number): Promise<void> {
  try {
    const alreadyPresent = await executeInMain<boolean>(
      tabId,
      () =>
        typeof (window as unknown as { __zenExtMcpEvaluate?: unknown })
          .__zenExtMcpEvaluate === "function",
      [],
    );
    if (alreadyPresent) return;
    await withTimeout(
      browser.scripting.executeScript({
        target: { tabId },
        files: ["evaluate/inject.js"],
        world: "MAIN" as browser.scripting.ExecutionWorld,
      }),
      EXECUTE_SCRIPT_TIMEOUT_MS,
      `evaluator injection did not finish within ${EXECUTE_SCRIPT_TIMEOUT_MS}ms`,
    );
  } catch (err) {
    throw await scriptError(tabId, err);
  }
}

async function executeInMain<T>(
  tabId: number,
  func: (...args: unknown[]) => T | Promise<T>,
  args: unknown[],
  opts: { frameId?: number } = {},
): Promise<T> {
  let results: browser.scripting.InjectionResult[];
  try {
    results = await withTimeout(
      browser.scripting.executeScript({
        target:
          typeof opts.frameId === "number"
            ? { tabId, frameIds: [opts.frameId] }
            : { tabId },
        // The typings declare `func` as returning void; the real API hands its return value
        // (awaited, if a promise) back as InjectionResult.result, which is what we read below.
        func: func as (...args: unknown[]) => void,
        args,
        world: "MAIN" as browser.scripting.ExecutionWorld,
      }),
      EXECUTE_SCRIPT_TIMEOUT_MS,
      `page script did not finish within ${EXECUTE_SCRIPT_TIMEOUT_MS}ms; the page may be blocked by a dialog or a long-running main thread`,
    );
  } catch (err) {
    throw await scriptError(tabId, err);
  }
  const first = results[0];
  if (!first) throw new Error("no executeScript result");
  if (first.error) throw new Error(String(first.error));
  return first.result as T;
}

async function executeInAllFrames<T>(
  tabId: number,
  func: (...args: unknown[]) => T | Promise<T>,
  args: unknown[],
): Promise<browser.scripting.InjectionResult[]> {
  try {
    return await withTimeout(
      browser.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: func as (...args: unknown[]) => void,
        args,
        world: "MAIN" as browser.scripting.ExecutionWorld,
      }),
      EXECUTE_SCRIPT_TIMEOUT_MS,
      `page script did not finish within ${EXECUTE_SCRIPT_TIMEOUT_MS}ms; the page may be blocked by a dialog or a long-running main thread`,
    );
  } catch (err) {
    throw await scriptError(tabId, err);
  }
}

async function lookupUidEntry(tabId: number, uid: string): Promise<SnapshotUidEntry> {
  const map = await loadSnapshotCache(tabId);
  if (!map) throw new Error(`no snapshot for tabId=${tabId}; call take_snapshot first`);
  const entry = map.get(uid);
  if (!entry) throw new Error(`uid "${uid}" not found in snapshot for tabId=${tabId}`);
  return entry;
}

function requireLocatorParams(raw: unknown): {
  tabId: number;
  locator: LocatorSpec;
  timeoutMs?: number;
} {
  const p = raw as LocatorParams;
  const tabId = requireNumber(p?.tabId, "tabId");
  const locator = p?.locator;
  if (!locator || (locator.kind !== "css" && locator.kind !== "xpath")) {
    throw new Error('locator must be {kind:"css",selector} or {kind:"xpath",expression}');
  }
  return {
    tabId,
    locator,
    ...(typeof p.timeoutMs === "number" ? { timeoutMs: p.timeoutMs } : {}),
  };
}

function toCookieEntry(c: browser.cookies.Cookie): CookieEntry {
  const entry: CookieEntry = { name: c.name, value: c.value };
  if (c.domain) entry.domain = c.domain;
  if (c.path) entry.path = c.path;
  if (typeof c.expirationDate === "number") entry.expirationDate = c.expirationDate;
  if (typeof c.httpOnly === "boolean") entry.httpOnly = c.httpOnly;
  if (typeof c.secure === "boolean") entry.secure = c.secure;
  if (c.sameSite) entry.sameSite = c.sameSite as CookieEntry["sameSite"];
  if (c.storeId) entry.storeId = c.storeId;
  return entry;
}

function capText(text: string): string {
  if (text.length <= PAGE_TEXT_MAX_CHARS) return text;
  return `${text.slice(0, PAGE_TEXT_MAX_CHARS)}\n\n[truncated by extension at ${PAGE_TEXT_MAX_CHARS} chars]`;
}

async function collectFeedback(
  tabId: number,
  before: ActionFeedbackInput,
): Promise<InteractionResult["feedback"]> {
  let after: browser.tabs.Tab | null = null;
  try {
    after = await browser.tabs.get(tabId);
  } catch {
    // ignore
  }
  let activeElement: NonNullable<InteractionResult["feedback"]>["activeElement"] | undefined;
  try {
    activeElement = await executeInMain(tabId, () => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return undefined;
      const tag = el.tagName.toLowerCase();
      const name =
        el.getAttribute("aria-label") ||
        el.getAttribute("name") ||
        el.getAttribute("placeholder") ||
        el.textContent?.replace(/\s+/g, " ").trim().slice(0, 80) ||
        undefined;
      return { tag, ...(name ? { name } : {}) };
    }, []);
  } catch {
    activeElement = undefined;
  }
  const url = after?.url ?? before.url;
  return {
    url,
    title: after?.title ?? before.title,
    ...(activeElement ? { activeElement } : {}),
    navigated: url !== before.url,
  };
}

async function withFeedback(
  tabId: number,
  action: () => Promise<Omit<InteractionResult, "tabId" | "feedback"> | void>,
): Promise<InteractionResult> {
  const beforeTab = await browser.tabs.get(tabId);
  const before = { url: beforeTab.url ?? "", title: beforeTab.title ?? "" };
  const actionResult = (await action()) ?? {};
  return {
    tabId,
    ...actionResult,
    feedback: await collectFeedback(tabId, before),
  };
}

// Runs a fill/type interaction, escalating on a failed rich-editor insert.
// The injected command reports `filledStuck: false` only when both the trusted
// execCommand path (disabled without document focus) and the synthetic
// beforeinput path failed. In that case we bring the window to the front so the
// trusted path is enabled, then retry once. This is the last-resort tier: it
// steals OS focus, so it only fires when the quiet paths could not make the
// text stick (rare — framework editors accept the synthetic path).
async function runFillLike(
  tabId: number,
  command: Record<string, unknown>,
  frameId?: number,
): Promise<Record<string, unknown>> {
  const first = await executeInMain<Record<string, unknown>>(
    tabId,
    runInteractionCommand,
    [command],
    { frameId },
  );
  if (first?.filledStuck !== false) return first;
  try {
    const tab = await browser.tabs.get(tabId);
    if (tab.windowId !== undefined) {
      await browser.windows.update(tab.windowId, { focused: true });
    }
    await browser.tabs.update(tabId, { active: true });
    await new Promise((resolve) => setTimeout(resolve, 120));
  } catch {
    return first; // could not focus; surface the first attempt's result
  }
  return executeInMain<Record<string, unknown>>(tabId, runInteractionCommand, [command], {
    frameId,
  });
}

async function runInteractionCommand(raw: unknown): Promise<Record<string, unknown>> {
  const command = raw as Record<string, any>;
  const defaultTimeoutMs = 5_000;
  const pollMs = 200;

  const locatorLabel = (loc: LocatorSpec): string =>
    loc.kind === "css" ? loc.selector : loc.expression;

  const findByLocator = (loc: LocatorSpec): Element | null => {
    if (loc.kind === "css") return document.querySelector(loc.selector);
    return document.evaluate(
      loc.expression,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    ).singleNodeValue as Element | null;
  };

  const waitForLocator = async (
    loc: LocatorSpec,
    timeoutMs: number | undefined,
  ): Promise<Element> => {
    const total = typeof timeoutMs === "number" ? timeoutMs : defaultTimeoutMs;
    const start = Date.now();
    const deadline = start + total;
    while (Date.now() <= deadline) {
      const found = findByLocator(loc);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(`element not found: ${locatorLabel(loc)} after ${Date.now() - start}ms`);
  };

  const findBySelector = (selector: string): Element => {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`element not found: ${selector}`);
    return el;
  };

  const findTarget = async (): Promise<Element> => {
    if (typeof command.selector === "string") return findBySelector(command.selector);
    if (command.locator) {
      return waitForLocator(command.locator as LocatorSpec, command.timeoutMs as number | undefined);
    }
    throw new Error("selector or locator is required");
  };

  const center = (el: Element): { x: number; y: number } => {
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + Math.max(1, rect.width) / 2,
      y: rect.top + Math.max(1, rect.height) / 2,
    };
  };

  const scrollToElement = (el: Element): void => {
    if ("scrollIntoView" in el) {
      (el as HTMLElement).scrollIntoView({ block: "center", inline: "center" });
    }
  };

  const setNativeValue = (input: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(input, value);
    else input.value = value;
  };

  // Fills a contentEditable and reports (via DOM readback) whether the text
  // actually stuck. Tiered:
  //   1. execCommand("insertText") — the fully-trusted path, but ONLY when the
  //      document has system focus. Unfocused it lies (returns true, inserts
  //      nothing on framework editors), so we gate it on document.hasFocus()
  //      and never trust its return — we verify by reading the text back.
  //   2. synthetic beforeinput + explicit Range — framework editors
  //      (Lexical/ProseMirror/Slate) read the DOM selection, claim the
  //      beforeinput (preventDefault) and reconcile into their own model
  //      (~20ms, measured); plain contentEditables don't claim it, so we insert
  //      the text node ourselves. Either way the verdict is the readback.
  // A false return means neither path stuck -> the handler escalates (focus the
  // window so tier 1 becomes usable, then retries).
  const editableText = (el: HTMLElement, value: string): boolean => {
    const text = el.textContent ?? "";
    return value === "" ? text.trim() === "" : text.includes(value);
  };
  const settle = async (el: HTMLElement, value: string, capMs: number): Promise<boolean> => {
    const deadline = Date.now() + capMs;
    do {
      if (editableText(el, value)) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    return editableText(el, value);
  };
  const richInsert = async (el: HTMLElement, value: string): Promise<boolean> => {
    if (typeof el.focus === "function") el.focus();
    if (document.hasFocus()) {
      try {
        document.execCommand("selectAll");
        document.execCommand("insertText", false, value);
      } catch {
        // fall through to the synthetic path
      }
      if (await settle(el, value, 120)) return true;
    }
    try {
      if (typeof el.focus === "function") el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel?.removeAllRanges();
      sel?.addRange(range);
      const beforeinput = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: value,
      });
      const notClaimed = el.dispatchEvent(beforeinput);
      if (notClaimed) {
        // No framework handled it: perform the DOM edit and fire input ourselves.
        const r = sel && sel.rangeCount ? sel.getRangeAt(0) : range;
        r.deleteContents();
        if (value) r.insertNode(document.createTextNode(value));
        sel?.collapseToEnd();
        el.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }),
        );
      }
      // If the editor claimed the beforeinput it inserts + fires input itself;
      // dispatching another input here would double the text.
    } catch {
      // fall through to the readback verdict below
    }
    return settle(el, value, 500);
  };

  const fillElement = async (el: Element, value: string): Promise<boolean> => {
    scrollToElement(el);
    const html = el as HTMLElement;
    const input = el as HTMLInputElement | HTMLTextAreaElement;
    if ("value" in input && !html.isContentEditable) {
      setNativeValue(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } else if (html.isContentEditable) {
      const stuck = await richInsert(html, value);
      html.dispatchEvent(new Event("change", { bubbles: true }));
      return stuck;
    } else {
      throw new Error("element is not fillable");
    }
  };

  /**
   * What is painted on top of this element's click point, if anything.
   *
   * This does NOT change where the click goes: pointerClick dispatches the events on the
   * element itself, so a cookie banner cannot swallow them the way it would swallow a real
   * mouse click at those coordinates. It is a diagnosis. A control under a modal usually
   * still fires its handler and still does nothing the user can see, because the app is in
   * a modal state - and "clicked, nothing happened" is the single most confusing thing a
   * caller can be told. Naming the blocker turns that into an actionable message.
   *
   * elementFromPoint honours `pointer-events: none`, so decorative overlays never register.
   * Shadow DOM is skipped: `contains` does not cross a shadow boundary, so a target inside
   * one would always look covered by its own host.
   */
  const occludedBy = (el: Element, point: { x: number; y: number }): string | null => {
    try {
      if (el.getRootNode() !== document) return null;
      const hit = document.elementFromPoint(point.x, point.y);
      // No hit means the point is outside the viewport, which is not evidence of covering.
      if (!hit || hit === el || el.contains(hit) || hit.contains(el)) return null;
      const described = hit as HTMLElement;
      const name =
        described.getAttribute("aria-label") ??
        described.getAttribute("role") ??
        (described.id ? `#${described.id}` : "");
      const text = (described.innerText ?? described.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      const parts = [described.tagName.toLowerCase()];
      if (name) parts.push(`"${name}"`);
      if (text) parts.push(`text "${text}"`);
      return parts.join(" ");
    } catch {
      return null;
    }
  };

  /**
   * The absolute URL a click on this element would open in a NEW tab, or null.
   *
   * A synthetic click carries no user activation, so the popup blocker stops a `_blank`
   * link and the caller is told "clicked" while nothing visible happened. Naming the URL
   * lets them open it with open_url instead. Only `_blank` counts: a named target may be an
   * existing frame, which is a same-tab navigation. `<base target>` applies when the link
   * has no target of its own. A download link, or a non-http(s) href, opens no tab.
   */
  const newTabHref = (el: Element): string | null => {
    const link = el.closest("a[href], area[href]") as HTMLAnchorElement | HTMLAreaElement | null;
    if (!link || link.hasAttribute("download")) return null;
    const targetName = link.hasAttribute("target")
      ? link.getAttribute("target")
      : document.querySelector("base[target]")?.getAttribute("target");
    if ((targetName ?? "").trim().toLowerCase() !== "_blank") return null;
    return link.protocol === "http:" || link.protocol === "https:" ? link.href : null;
  };

  const pointerClick = (el: Element): { covering: string | null; opensNewTab: string | null } => {
    scrollToElement(el);
    const target = el as HTMLElement;
    const point = center(el);
    const covering = occludedBy(el, point);
    const pointerBase: PointerEventInit = {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    };
    // Honour the page cancelling the press, as a browser does. A cancelled pointerdown
    // suppresses the compatibility mousedown/mouseup (Pointer Events spec), and a cancelled
    // press - either event - leaves focus where it was. Menu triggers cancel pointerdown
    // precisely so the trigger doesn't take focus from the menu they open, and close the
    // menu on focus-out, so forcing focus here opened and immediately closed them.
    // `click` still fires either way, as it does in a browser.
    let pressAllowed = true;
    if (typeof PointerEvent === "function") {
      pressAllowed = target.dispatchEvent(new PointerEvent("pointerdown", { ...pointerBase, buttons: 1 }));
    }
    let focusAllowed = pressAllowed;
    if (pressAllowed) {
      focusAllowed = target.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          clientX: point.x,
          clientY: point.y,
          button: 0,
          buttons: 1,
        }),
      );
    }
    if (focusAllowed && typeof target.focus === "function") {
      try {
        target.focus({ preventScroll: true });
      } catch {
        target.focus();
      }
    }
    if (typeof PointerEvent === "function") {
      target.dispatchEvent(new PointerEvent("pointerup", { ...pointerBase, buttons: 0 }));
    }
    if (pressAllowed) {
      target.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          clientX: point.x,
          clientY: point.y,
          button: 0,
          buttons: 0,
        }),
      );
    }
    const clickAllowed = target.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
        button: 0,
      }),
    );
    // A page that cancels the click (a client-side router) opens no tab itself.
    return { covering, opensNewTab: clickAllowed ? newTabHref(el) : null };
  };

  const hoverElement = (el: Element): void => {
    scrollToElement(el);
    const target = el as HTMLElement;
    const point = center(el);
    const mouse: MouseEventInit = {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
    };
    const pointer: PointerEventInit = {
      ...mouse,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
    };
    if (typeof PointerEvent === "function") {
      target.dispatchEvent(new PointerEvent("pointerover", pointer));
      target.dispatchEvent(new PointerEvent("pointerenter", pointer));
    }
    target.dispatchEvent(new MouseEvent("mouseover", mouse));
    target.dispatchEvent(new MouseEvent("mouseenter", mouse));
    target.dispatchEvent(new MouseEvent("mousemove", mouse));
  };

  const typeChar = (editable: HTMLElement, ch: string): void => {
    // execCommand only genuinely inserts when the document has focus; unfocused
    // it lies (returns true, inserts nothing on framework editors), so gate it.
    if (document.hasFocus()) {
      try {
        if (document.execCommand("insertText", false, ch)) return;
      } catch {
        // fall through to the synthetic path
      }
    }
    const sel = window.getSelection();
    const beforeinput = new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: ch,
    });
    if (!editable.dispatchEvent(beforeinput)) return; // editor claimed it
    let range = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    if (!range) {
      range = document.createRange();
      range.selectNodeContents(editable);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
    range.deleteContents();
    range.insertNode(document.createTextNode(ch));
    range.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(range);
    editable.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }),
    );
  };

  const typeElement = async (
    el: Element,
    text: string,
    delayMs: number,
    clearFirst: boolean,
  ): Promise<boolean> => {
    scrollToElement(el);
    const input = el as HTMLInputElement | HTMLTextAreaElement;
    const focusable = el as HTMLElement;
    const editable = focusable.isContentEditable;
    if (clearFirst) {
      if ("value" in input && !editable) {
        setNativeValue(input, "");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (editable) {
        await richInsert(focusable, "");
      }
    }
    if (typeof focusable.focus === "function") focusable.focus();
    for (const ch of text) {
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent("keypress", { key: ch, bubbles: true, cancelable: true }));
      if ("value" in input && !editable) {
        setNativeValue(input, `${input.value ?? ""}${ch}`);
        input.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch }));
      } else if (editable) {
        typeChar(focusable, ch);
      }
      el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if ("value" in input && !editable) {
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    if (editable) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      const current = focusable.textContent ?? "";
      return text === "" ? true : current.includes(text);
    }
    return true;
  };

  const dragElements = (from: Element, to: Element): void => {
    scrollToElement(from);
    scrollToElement(to);
    const dt = new DataTransfer();
    from.dispatchEvent(new DragEvent("dragstart", { dataTransfer: dt, bubbles: true }));
    to.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
    to.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true }));
    to.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true }));
    from.dispatchEvent(new DragEvent("dragend", { dataTransfer: dt, bubbles: true }));
  };

  const pressKeys = async (): Promise<void> => {
    const target = command.target as PressKeyParams["target"];
    let el: Element | null = document.activeElement ?? document.body;
    if (target?.kind === "locator") {
      el = await waitForLocator(target.locator, command.timeoutMs as number | undefined);
      scrollToElement(el);
      if (typeof (el as HTMLElement).focus === "function") (el as HTMLElement).focus();
    }
    if (!el) throw new Error("no active element");
    const spec = String(command.keys ?? "");
    const parts = spec.split("+").map((p) => p.trim()).filter(Boolean);
    const special: Record<string, string> = {
      enter: "Enter",
      return: "Enter",
      escape: "Escape",
      esc: "Escape",
      tab: "Tab",
      backspace: "Backspace",
      delete: "Delete",
      insert: "Insert",
      space: " ",
      arrowup: "ArrowUp",
      up: "ArrowUp",
      arrowdown: "ArrowDown",
      down: "ArrowDown",
      arrowleft: "ArrowLeft",
      left: "ArrowLeft",
      arrowright: "ArrowRight",
      right: "ArrowRight",
      home: "Home",
      end: "End",
      pageup: "PageUp",
      pagedown: "PageDown",
    };
    const modifiers = new Set(["cmd", "meta", "ctrl", "control", "alt", "option", "shift"]);
    const init: KeyboardEventInit = { bubbles: true, cancelable: true };
    for (const m of parts.slice(0, -1)) {
      const lower = m.toLowerCase();
      if (!modifiers.has(lower)) throw new Error(`unknown modifier: ${m}`);
      if (lower === "cmd" || lower === "meta") init.metaKey = true;
      if (lower === "ctrl" || lower === "control") init.ctrlKey = true;
      if (lower === "alt" || lower === "option") init.altKey = true;
      if (lower === "shift") init.shiftKey = true;
    }
    const main = parts[parts.length - 1] ?? "";
    init.key = special[main.toLowerCase()] ?? main;
    el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keypress", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
  };

  if (command.kind === "click") {
    const el = await findTarget();
    const { covering, opensNewTab } = pointerClick(el);
    return {
      matchedTag: (el as HTMLElement).tagName,
      ...(covering ? { occludedBy: covering } : {}),
      ...(opensNewTab ? { opensNewTab } : {}),
    };
  }
  if (command.kind === "hover") {
    const el = await findTarget();
    hoverElement(el);
    return { matchedTag: (el as HTMLElement).tagName };
  }
  if (command.kind === "fill") {
    const el = await findTarget();
    const stuck = await fillElement(el, String(command.value ?? ""));
    return { matchedTag: (el as HTMLElement).tagName, filledStuck: stuck };
  }
  if (command.kind === "fillForm") {
    const entries = command.entries as Array<{ selector: string; value: string }>;
    let stuck = true;
    for (const entry of entries) {
      const one = await fillElement(findBySelector(entry.selector), entry.value);
      stuck = one && stuck;
    }
    return { filledStuck: stuck };
  }
  if (command.kind === "type") {
    const el = await findTarget();
    const stuck = await typeElement(
      el,
      String(command.text ?? ""),
      typeof command.delayMs === "number" ? command.delayMs : 0,
      command.clearFirst === true,
    );
    return { matchedTag: (el as HTMLElement).tagName, filledStuck: stuck };
  }
  if (command.kind === "drag") {
    const from =
      typeof command.fromSelector === "string"
        ? findBySelector(command.fromSelector)
        : await waitForLocator(command.from as LocatorSpec, command.timeoutMs as number | undefined);
    const to =
      typeof command.toSelector === "string"
        ? findBySelector(command.toSelector)
        : await waitForLocator(command.to as LocatorSpec, command.timeoutMs as number | undefined);
    dragElements(from, to);
    return { matchedTag: (to as HTMLElement).tagName };
  }
  if (command.kind === "select") {
    const el = await findTarget();
    scrollToElement(el);
    if ((el as HTMLElement).tagName !== "SELECT") {
      return { ok: false, reason: "not_select", tag: (el as HTMLElement).tagName };
    }
    const sel = el as HTMLSelectElement;
    let match: HTMLOptionElement | null = null;
    for (let i = 0; i < sel.options.length; i++) {
      const opt = sel.options[i] as HTMLOptionElement;
      if (command.by === "value" && opt.value === command.value) match = opt;
      if (command.by === "label" && opt.text === command.value) match = opt;
      if (command.by === "index" && i === Number.parseInt(String(command.value), 10)) match = opt;
      if (match) break;
    }
    if (!match) return { ok: false, reason: "no_match" };
    sel.value = match.value;
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, value: match.value, label: match.text };
  }
  if (command.kind === "press") {
    await pressKeys();
    return {};
  }
  throw new Error(`unknown interaction command: ${String(command.kind)}`);
}

async function runScrollCommand(raw: unknown): Promise<Omit<ScrollResult, "tabId">> {
  const params = raw as Record<string, any>;
  const pollMs = 200;
  const defaultTimeoutMs = 5_000;
  const findByLocator = (loc: LocatorSpec): Element | null => {
    if (loc.kind === "css") return document.querySelector(loc.selector);
    return document.evaluate(
      loc.expression,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    ).singleNodeValue as Element | null;
  };
  const waitForLocator = async (loc: LocatorSpec): Promise<Element> => {
    const total = typeof params.timeoutMs === "number" ? params.timeoutMs : defaultTimeoutMs;
    const start = Date.now();
    const deadline = start + total;
    while (Date.now() <= deadline) {
      const found = findByLocator(loc);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    const label = loc.kind === "css" ? loc.selector : loc.expression;
    throw new Error(`element not found: ${label} after ${Date.now() - start}ms`);
  };

  if (typeof params.selector === "string") {
    const el = document.querySelector(params.selector);
    if (!el) throw new Error(`element not found: ${params.selector}`);
    el.scrollIntoView({ block: "center", inline: "center" });
  } else if (params.locator) {
    const el = await waitForLocator(params.locator as LocatorSpec);
    el.scrollIntoView({ block: "center", inline: "center" });
  } else {
    const dx = typeof params.x === "number" ? params.x : 0;
    let dy = typeof params.y === "number" ? params.y : 0;
    if (typeof params.pages === "number") dy += params.pages * window.innerHeight;
    window.scrollBy(dx, dy);
  }

  const doc = document.documentElement;
  const maxX = Math.max(0, doc.scrollWidth - window.innerWidth);
  const maxY = Math.max(0, doc.scrollHeight - window.innerHeight);
  const x = window.scrollX;
  const y = window.scrollY;
  return {
    x,
    y,
    atTop: y <= 0,
    atBottom: y >= maxY - 1,
    atLeft: x <= 0,
    atRight: x >= maxX - 1,
  };
}

export const handlers: Record<string, Handler> = {
  [Methods.ContainersList]: async () => {
    const identities = await browser.contextualIdentities.query({});
    const containers: FirefoxContainer[] = identities.map((id) => ({
      cookieStoreId: id.cookieStoreId,
      name: id.name,
      color: id.color,
      icon: id.icon,
    }));
    return { containers };
  },

  [Methods.PagesList]: async (raw) => {
    const params = (raw ?? {}) as PagesListParams;
    const [tabs, names] = await Promise.all([
      browser.tabs.query({}),
      buildContainerLookup(),
    ]);
    const pages = tabs.map((t) => tabToPageInfo(t, names, true));
    if (params.includeHidden) {
      const hidden = await probeHiddenWorkspaceTabs(tabs);
      for (const t of hidden) pages.push(tabToPageInfo(t, names, false));
    }
    return { pages };
  },

  [Methods.PagesGet]: async (raw): Promise<GetPageResult> => {
    const params = raw as GetPageParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const [visible, names] = await Promise.all([
      browser.tabs.query({}),
      buildContainerLookup(),
    ]);
    const shown = visible.find((t) => t.id === tabId);
    if (shown) return { page: tabToPageInfo(shown, names, true) };
    try {
      const tab = await browser.tabs.get(tabId);
      noteTabId(tab.id);
      return { page: tabToPageInfo(tab, names, false) };
    } catch {
      return { page: null };
    }
  },

  [Methods.PagesNew]: async (raw): Promise<NewPageResult> => {
    const params = raw as NewPageParams;
    const url = requireString(params?.url, "url");
    const createOpts: browser.tabs._CreateCreateProperties = { url, active: params.active ?? false };
    if (params.cookieStoreId) {
      createOpts.cookieStoreId = params.cookieStoreId;
      // Pin the window explicitly rather than inherit focus, which may be on a private
      // window where a container tab is illegal (see containerWindowId).
      const windowId = await containerWindowId();
      if (windowId === null) {
        throw new Error(
          "no ordinary window to open a container tab in - every window this extension can see is private or closed. Open a normal Zen window and retry.",
        );
      }
      createOpts.windowId = windowId;
    }
    const tab = await browser.tabs.create(createOpts);
    const names = await buildContainerLookup();
    const cookieStoreId = tab.cookieStoreId ?? params.cookieStoreId ?? "firefox-default";
    return {
      tabId: tab.id ?? -1,
      windowId: tab.windowId ?? -1,
      url: tab.url ?? url,
      cookieStoreId,
      containerName: names.get(cookieStoreId) ?? null,
    };
  },

  [Methods.PagesNavigate]: async (raw): Promise<TabIdResult> => {
    const params = raw as NavigatePageParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const url = requireString(params?.url, "url");
    await browser.tabs.update(tabId, { url });
    return { tabId };
  },

  [Methods.PagesSelect]: async (raw): Promise<TabIdResult> => {
    const params = raw as SelectPageParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const tab = await browser.tabs.update(tabId, { active: true });
    // A tab in another Zen space is selected only after Zen finishes switching spaces.
    if (!tab.active) await waitForTabActive(tabId, 3000);
    if (tab.windowId !== undefined) {
      await browser.windows.update(tab.windowId, { focused: true });
    }
    return { tabId };
  },

  [Methods.PagesClose]: async (raw): Promise<TabIdResult> => {
    const params = raw as ClosePageParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    await browser.tabs.remove(tabId);
    return { tabId };
  },

  [Methods.PagesNavigateHistory]: async (raw): Promise<TabIdResult> => {
    const params = raw as NavigateHistoryParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    if (params.direction !== "back" && params.direction !== "forward") {
      throw new Error('direction must be "back" or "forward"');
    }
    if (params.direction === "back") {
      await browser.tabs.goBack(tabId);
    } else {
      await browser.tabs.goForward(tabId);
    }
    return { tabId };
  },

  [Methods.PagesScreenshot]: async (raw): Promise<ScreenshotPageResult> => {
    const params = raw as ScreenshotPageParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const format = params.format === "png" ? "png" : "jpeg";
    const quality =
      typeof params.quality === "number"
        ? Math.max(0, Math.min(100, Math.round(params.quality)))
        : 80;
    const dataUrl = await browser.tabs.captureTab(tabId, { format, quality });
    return { tabId, dataUrl };
  },

  [Methods.DomTakeSnapshot]: async (raw): Promise<TakeSnapshotResult> => {
    const params = raw as TakeSnapshotParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const includeIframes = params.includeIframes !== false;
    await ensureSnapshotInjected(tabId, includeIframes);
    const snapshotId = nextSnapshotId++;
    type FrameSnapshotResult = {
      tree: TakeSnapshotResult["tree"];
      uidMap: SnapshotUidEntry[];
      truncated: boolean;
      selectorError?: string;
      snapshotError?: string;
      frameUrl?: string;
    };
    const capture = (id: unknown, opts: unknown): FrameSnapshotResult => {
      const fn = (window as unknown as {
        __zenExtMcpCreateSnapshot?: (i: number, o: unknown) => unknown;
      }).__zenExtMcpCreateSnapshot;
      if (!fn) throw new Error("snapshot fn not present");
      const result = fn(id as number, opts) as FrameSnapshotResult;
      return { ...result, frameUrl: window.location.href };
    };
    const snapshotOptions = {
      selector: params.selector,
      includeAll: params.includeAll,
      includeIframes: false,
    };
    const results = includeIframes
      ? await executeInAllFrames<FrameSnapshotResult>(tabId, capture, [
          snapshotId,
          snapshotOptions,
        ])
      : [
          {
            frameId: 0,
            result: await executeInMain<FrameSnapshotResult>(tabId, capture, [
              snapshotId,
              snapshotOptions,
            ]),
          } as browser.scripting.InjectionResult,
        ];

    const rewriteUid = (uid: string, frameId: number): string => {
      if (frameId === 0) return uid;
      const prefix = `${snapshotId}_`;
      const suffix = uid.startsWith(prefix) ? uid.slice(prefix.length) : uid;
      return `${snapshotId}_f${frameId}_${suffix}`;
    };
    const rewriteTree = (
      node: TakeSnapshotResult["tree"],
      frameId: number,
      frameUrl: string | undefined,
    ): TakeSnapshotResult["tree"] => {
      if (!node) return null;
      const children = node.children
        .map((child) => rewriteTree(child, frameId, undefined))
        .filter((child): child is NonNullable<TakeSnapshotResult["tree"]> => child !== null);
      const rewritten: TakeSnapshotResult["tree"] = {
        ...node,
        uid: rewriteUid(node.uid, frameId),
        children,
      };
      if (frameId !== 0) {
        rewritten.isIframe = true;
        if (frameUrl) rewritten.frameSrc = frameUrl;
      }
      return rewritten;
    };

    const uidMapByUid = new Map<string, SnapshotUidEntry>();
    const uidMap: SnapshotUidEntry[] = [];
    let tree: TakeSnapshotResult["tree"] = null;
    let truncated = false;
    let selectorError: string | undefined;
    let snapshotError: string | undefined;

    for (const injection of results) {
      if (injection.error || !injection.result) continue;
      const frameId = injection.frameId ?? 0;
      const result = injection.result as FrameSnapshotResult;
      truncated = truncated || result.truncated;
      if (result.selectorError && !selectorError) selectorError = result.selectorError;
      if (result.snapshotError && !snapshotError) snapshotError = result.snapshotError;
      for (const entry of result.uidMap) {
        const rewritten = {
          ...entry,
          uid: rewriteUid(entry.uid, frameId),
          ...(frameId !== 0 ? { frameId } : {}),
        };
        uidMap.push(rewritten);
        uidMapByUid.set(rewritten.uid, rewritten);
      }
      const frameTree = rewriteTree(result.tree, frameId, result.frameUrl);
      if (!frameTree) continue;
      if (frameId === 0) {
        tree = frameTree;
      } else if (tree) {
        tree.children.push(frameTree);
      }
    }

    snapshotCache.set(tabId, uidMapByUid);
    await persistSnapshotCache(tabId, uidMapByUid);

    return {
      tabId,
      snapshotId,
      tree,
      uidMap,
      truncated,
      ...(selectorError && uidMap.length === 0 ? { selectorError } : {}),
      // Reported whenever the walk threw, even if another frame still produced a tree:
      // a partial snapshot that lost a frame to a bug must not look complete.
      ...(snapshotError ? { snapshotError } : {}),
    };
  },

  [Methods.DomClearSnapshot]: async (raw): Promise<TabIdResult> => {
    const params = raw as ClearSnapshotParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    await clearSnapshotCache(tabId);
    return { tabId };
  },

  [Methods.DomResolveUidToSelector]: async (raw): Promise<ResolveUidResult> => {
    const params = raw as UidActionParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const uid = requireString(params?.uid, "uid");
    const entry = await lookupUidEntry(tabId, uid);
    return entry;
  },

  [Methods.DomClick]: async (raw): Promise<InteractionResult> => {
    const params = raw as UidActionParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const uid = requireString(params?.uid, "uid");
    const entry = await lookupUidEntry(tabId, uid);
    return withFeedback(tabId, async () =>
      executeInMain(
        tabId,
        runInteractionCommand,
        [{ kind: "click", selector: entry.css }],
        { frameId: entry.frameId },
      ),
    );
  },

  [Methods.DomHover]: async (raw): Promise<InteractionResult> => {
    const params = raw as UidActionParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const uid = requireString(params?.uid, "uid");
    const entry = await lookupUidEntry(tabId, uid);
    return withFeedback(tabId, async () =>
      executeInMain(
        tabId,
        runInteractionCommand,
        [{ kind: "hover", selector: entry.css }],
        { frameId: entry.frameId },
      ),
    );
  },

  [Methods.DomFill]: async (raw): Promise<InteractionResult> => {
    const params = raw as FillParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const uid = requireString(params?.uid, "uid");
    if (typeof params.value !== "string") throw new Error("value must be a string");
    const entry = await lookupUidEntry(tabId, uid);
    return withFeedback(tabId, async () => {
      const result = await runFillLike(
        tabId,
        { kind: "fill", selector: entry.css, value: params.value },
        entry.frameId,
      );
      delete result.filledStuck;
      return result;
    });
  },

  [Methods.DomFillForm]: async (raw): Promise<InteractionResult> => {
    const params = raw as FillFormParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    if (!Array.isArray(params.fields)) throw new Error("fields must be an array");
    const groups = new Map<number | undefined, Array<{ selector: string; value: string }>>();
    for (const field of params.fields) {
      const entry = await lookupUidEntry(tabId, field.uid);
      const list = groups.get(entry.frameId) ?? [];
      list.push({ selector: entry.css, value: field.value });
      groups.set(entry.frameId, list);
    }
    return withFeedback(tabId, async () => {
      for (const [frameId, entries] of groups) {
        await runFillLike(tabId, { kind: "fillForm", entries }, frameId);
      }
      return {};
    });
  },

  [Methods.DomDrag]: async (raw): Promise<InteractionResult> => {
    const params = raw as DragParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const fromUid = requireString(params?.fromUid, "fromUid");
    const toUid = requireString(params?.toUid, "toUid");
    const from = await lookupUidEntry(tabId, fromUid);
    const to = await lookupUidEntry(tabId, toUid);
    if (from.frameId !== to.frameId) throw new Error("cannot drag across frames");
    return withFeedback(tabId, async () =>
      executeInMain(
        tabId,
        runInteractionCommand,
        [{ kind: "drag", fromSelector: from.css, toSelector: to.css }],
        { frameId: from.frameId },
      ),
    );
  },

  [Methods.DomGetPageText]: async (raw): Promise<GetPageTextResult> => {
    const params = raw as GetPageTextParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const selector = params.selector;
    const text = await executeInMain<string>(
      tabId,
      (sel) => {
        const target =
          typeof sel === "string" && sel.length > 0
            ? document.querySelector(sel as string)
            : document.body;
        if (!target) throw new Error("element not found");
        const node = target as HTMLElement;
        const visible = node.innerText;
        return typeof visible === "string" ? visible : node.textContent ?? "";
      },
      [selector ?? null],
    );
    return { text: capText(text) };
  },

  [Methods.DomReadPage]: async (raw): Promise<ReadPageResult> => {
    const params = raw as ReadPageParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    try {
      await withTimeout(
        browser.scripting.executeScript({
          target: { tabId },
          files: ["readability/inject.js"],
          world: "MAIN" as browser.scripting.ExecutionWorld,
        }),
        EXECUTE_SCRIPT_TIMEOUT_MS,
        `readability injection did not finish within ${EXECUTE_SCRIPT_TIMEOUT_MS}ms`,
      );
    } catch (err) {
      throw await scriptError(tabId, err);
    }
    const result = await executeInMain<ReadPageResult>(
      tabId,
      () => {
        const fn = (window as unknown as { __zenReadability?: () => ReadPageResult })
          .__zenReadability;
        if (!fn) return { ok: false, reason: "bundle_unavailable" };
        return fn();
      },
      [],
    );
    if (typeof result.markdown === "string") result.markdown = capText(result.markdown);
    return result;
  },

  [Methods.DomClickByLocator]: async (raw): Promise<InteractionResult> => {
    const { tabId, locator, timeoutMs } = requireLocatorParams(raw);
    return withFeedback(tabId, async () =>
      executeInMain(tabId, runInteractionCommand, [
        { kind: "click", locator, timeoutMs },
      ]),
    );
  },

  [Methods.DomHoverByLocator]: async (raw): Promise<InteractionResult> => {
    const { tabId, locator, timeoutMs } = requireLocatorParams(raw);
    return withFeedback(tabId, async () =>
      executeInMain(tabId, runInteractionCommand, [
        { kind: "hover", locator, timeoutMs },
      ]),
    );
  },

  [Methods.DomFillByLocator]: async (raw): Promise<InteractionResult> => {
    const params = raw as FillByLocatorParams;
    const { tabId, locator, timeoutMs } = requireLocatorParams(params);
    if (typeof params.value !== "string") throw new Error("value must be a string");
    return withFeedback(tabId, async () => {
      const result = await runFillLike(tabId, {
        kind: "fill",
        locator,
        value: params.value,
        timeoutMs,
      });
      delete result.filledStuck;
      return result;
    });
  },

  [Methods.DomTypeByLocator]: async (raw): Promise<InteractionResult> => {
    const params = raw as TypeByLocatorParams;
    const { tabId, locator, timeoutMs } = requireLocatorParams(params);
    if (typeof params.text !== "string") throw new Error("text must be a string");
    return withFeedback(tabId, async () => {
      const result = await runFillLike(tabId, {
        kind: "type",
        locator,
        text: params.text,
        delayMs: typeof params.delayMs === "number" ? params.delayMs : 0,
        clearFirst: params.clearFirst === true,
        timeoutMs,
      });
      delete result.filledStuck;
      return result;
    });
  },

  [Methods.DomDragByLocator]: async (raw): Promise<InteractionResult> => {
    const params = raw as DragByLocatorParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    if (!params.from || !params.to) throw new Error("from and to are required");
    const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : undefined;
    return withFeedback(tabId, async () =>
      executeInMain(tabId, runInteractionCommand, [
        { kind: "drag", from: params.from, to: params.to, timeoutMs },
      ]),
    );
  },

  [Methods.DomSelectOptionByLocator]: async (raw): Promise<SelectOptionResult> => {
    const params = raw as SelectOptionByLocatorParams;
    const { tabId, locator, timeoutMs } = requireLocatorParams(params);
    if (typeof params.value !== "string") throw new Error("value is required");
    if (params.by !== "value" && params.by !== "label" && params.by !== "index") {
      throw new Error('by must be "value", "label", or "index"');
    }
    const beforeTab = await browser.tabs.get(tabId);
    // runInteractionCommand is one dispatcher for every command, typed as a plain record; its
    // "select" branch is what builds this shape.
    const result = (await executeInMain(
      tabId,
      runInteractionCommand,
      [{ kind: "select", locator, by: params.by, value: params.value, timeoutMs }],
    )) as unknown as SelectOptionResult;
    return {
      ...result,
      feedback: await collectFeedback(tabId, {
        url: beforeTab.url ?? "",
        title: beforeTab.title ?? "",
      }),
    };
  },

  [Methods.DomPressKey]: async (raw): Promise<InteractionResult> => {
    const params = raw as PressKeyParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    if (!params.keys || typeof params.keys !== "string") throw new Error("keys is required");
    const target = params.target ?? { kind: "active" };
    return withFeedback(tabId, async () =>
      executeInMain(tabId, runInteractionCommand, [
        {
          kind: "press",
          target,
          keys: params.keys,
          timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined,
        },
      ]),
    );
  },

  [Methods.DomScroll]: async (raw): Promise<ScrollResult> => {
    const params = raw as ScrollParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const command: Record<string, unknown> = {};
    let frameId: number | undefined;
    if (params.uid) {
      const entry = await lookupUidEntry(tabId, params.uid);
      command.selector = entry.css;
      frameId = entry.frameId;
    } else if (params.locator) {
      command.locator = params.locator;
    } else {
      if (typeof params.x === "number") command.x = params.x;
      if (typeof params.y === "number") command.y = params.y;
      if (typeof params.pages === "number") command.pages = params.pages;
    }
    if (typeof params.timeoutMs === "number") command.timeoutMs = params.timeoutMs;
    const result = await executeInMain<Omit<ScrollResult, "tabId">>(
      tabId,
      runScrollCommand,
      [command],
      { frameId },
    );
    return { tabId, ...result };
  },

  [Methods.CookiesGet]: async (raw): Promise<GetCookiesResult> => {
    const params = (raw as GetCookiesParams) ?? {};
    const details: browser.cookies._GetAllDetails = {};
    if (params.url) details.url = params.url;
    if (params.name) details.name = params.name;
    if (params.domain) details.domain = params.domain;
    if (params.storeId) details.storeId = params.storeId;
    const list = await browser.cookies.getAll(details);
    return { cookies: list.map(toCookieEntry) };
  },

  [Methods.CookiesSet]: async (raw): Promise<SetCookiesResult> => {
    const params = (raw as SetCookiesParams) ?? { cookies: [] };
    if (!Array.isArray(params.cookies) || params.cookies.length === 0) {
      throw new Error("cookies must be a non-empty array");
    }
    let set = 0;
    const failures: NonNullable<SetCookiesResult["failures"]> = [];
    for (const c of params.cookies) {
      if (!c.url || !c.name || typeof c.value !== "string") {
        throw new Error("each cookie requires url, name, value");
      }
      const opts: browser.cookies._SetDetails = {
        url: c.url,
        name: c.name,
        value: c.value,
      };
      if (c.domain) opts.domain = c.domain;
      if (c.path) opts.path = c.path;
      if (typeof c.expirationDate === "number") opts.expirationDate = c.expirationDate;
      if (typeof c.httpOnly === "boolean") opts.httpOnly = c.httpOnly;
      if (typeof c.secure === "boolean") opts.secure = c.secure;
      if (c.sameSite) opts.sameSite = c.sameSite as browser.cookies.SameSiteStatus;
      if (c.storeId) opts.storeId = c.storeId;
      try {
        const result = await browser.cookies.set(opts);
        if (result) {
          set += 1;
        } else {
          failures.push({
            name: c.name,
            ...(c.domain ? { domain: c.domain } : {}),
            reason: "browser.cookies.set returned null",
          });
        }
      } catch (err) {
        failures.push({
          name: c.name,
          ...(c.domain ? { domain: c.domain } : {}),
          reason: (err as Error).message,
        });
      }
    }
    return { set, ...(failures.length > 0 ? { failures } : {}) };
  },

  [Methods.CookiesClear]: async (raw): Promise<ClearCookiesResult> => {
    const params = (raw as ClearCookiesParams) ?? {};
    if (!params.url && !params.name && !params.domain && !params.storeId) {
      throw new Error(
        "clear_cookies requires at least one of: url, name, domain, storeId. Refusing to wipe all cookies.",
      );
    }
    const details: browser.cookies._GetAllDetails = {};
    if (params.url) details.url = params.url;
    if (params.name) details.name = params.name;
    if (params.domain) details.domain = params.domain;
    if (params.storeId) details.storeId = params.storeId;
    const list = await browser.cookies.getAll(details);
    let deleted = 0;
    const failures: NonNullable<ClearCookiesResult["failures"]> = [];
    for (const c of list) {
      const domain = c.domain.replace(/^\./, "");
      const path = c.path || "/";
      const removeOpts: browser.cookies._RemoveDetails = {
        url: details.url ?? `http${c.secure ? "s" : ""}://${domain}${path}`,
        name: c.name,
      };
      if (c.storeId) removeOpts.storeId = c.storeId;
      try {
        const result = await browser.cookies.remove(removeOpts);
        if (result) {
          deleted += 1;
        } else {
          failures.push({
            name: c.name,
            ...(c.domain ? { domain: c.domain } : {}),
            reason: "browser.cookies.remove returned null",
          });
        }
      } catch (err) {
        failures.push({
          name: c.name,
          ...(c.domain ? { domain: c.domain } : {}),
          reason: (err as Error).message,
        });
      }
    }
    return { deleted, ...(failures.length > 0 ? { failures } : {}) };
  },

  [Methods.StorageGet]: async (raw): Promise<StorageGetResult> => {
    const params = raw as StorageGetParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    if (params.kind !== "local" && params.kind !== "session") {
      throw new Error('kind must be "local" or "session"');
    }
    const kind = params.kind;
    const keys = Array.isArray(params.keys) ? params.keys : null;
    const items = await executeInMain<Record<string, string | null>>(
      tabId,
      (k, requestedKeys) => {
        const store: Storage =
          (k as string) === "session" ? window.sessionStorage : window.localStorage;
        const out: Record<string, string | null> = {};
        const list = requestedKeys as string[] | null;
        if (list && Array.isArray(list)) {
          for (const key of list) out[key] = store.getItem(key);
        } else {
          for (let i = 0; i < store.length; i++) {
            const key = store.key(i);
            if (key !== null) out[key] = store.getItem(key);
          }
        }
        return out;
      },
      [kind, keys],
    );
    return { items };
  },

  [Methods.StorageSet]: async (raw): Promise<StorageSetResult> => {
    const params = raw as StorageSetParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    if (params.kind !== "local" && params.kind !== "session") {
      throw new Error('kind must be "local" or "session"');
    }
    if (!params.items || typeof params.items !== "object") {
      throw new Error("items must be a string-valued object");
    }
    const kind = params.kind;
    const items = params.items;
    const written = await executeInMain<number>(
      tabId,
      (k, m) => {
        const store: Storage =
          (k as string) === "session" ? window.sessionStorage : window.localStorage;
        const obj = m as Record<string, string>;
        let count = 0;
        for (const key of Object.keys(obj)) {
          store.setItem(key, String(obj[key]));
          count += 1;
        }
        return count;
      },
      [kind, items],
    );
    return { written };
  },

  [Methods.StorageClear]: async (raw): Promise<StorageClearResult> => {
    const params = raw as StorageClearParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    if (params.kind !== "local" && params.kind !== "session") {
      throw new Error('kind must be "local" or "session"');
    }
    const kind = params.kind;
    const keys = params.keys;
    if (keys !== undefined) {
      if (!Array.isArray(keys)) throw new Error("keys must be an array");
      if (keys.length === 0) return { removed: 0, cleared: false };
      const removed = await executeInMain<number>(
        tabId,
        (k, list) => {
          const store: Storage =
            (k as string) === "session" ? window.sessionStorage : window.localStorage;
          const items = list as string[];
          for (const key of items) store.removeItem(key);
          return items.length;
        },
        [kind, keys],
      );
      return { removed, cleared: false };
    }
    await executeInMain<void>(
      tabId,
      (k) => {
        const store: Storage =
          (k as string) === "session" ? window.sessionStorage : window.localStorage;
        store.clear();
      },
      [kind],
    );
    return { removed: 0, cleared: true };
  },

  [Methods.DomEvaluate]: async (raw): Promise<EvaluateScriptResult> => {
    const params = raw as EvaluateScriptParams;
    const tabId = requireNumber(params?.tabId, "tabId");
    const code = requireString(params?.code, "code");
    await ensureEvaluatorInjected(tabId);
    const result = await executeInMain<unknown>(
      tabId,
      (src) => {
        const fn = (window as unknown as {
          __zenExtMcpEvaluate?: (source: string) => unknown;
        }).__zenExtMcpEvaluate;
        if (!fn) throw new Error("CSP-safe evaluator is unavailable");
        return fn(src as string);
      },
      [code],
    );
    return { result };
  },

  [Methods.InfoGet]: async (): Promise<InfoGetResult> => {
    const manifest = browser.runtime.getManifest();
    const [tabs, windows, identities, platform] = await Promise.all([
      browser.tabs.query({}),
      browser.windows.getAll({}),
      browser.contextualIdentities.query({}),
      browser.runtime.getPlatformInfo(),
    ]);
    return {
      extensionId: browser.runtime.id ?? "",
      extensionVersion: manifest.version ?? "",
      userAgent: navigator.userAgent,
      platform: `${platform.os}/${platform.arch}`,
      windowCount: windows.length,
      tabCount: tabs.length,
      containerCount: identities.length,
      protocolVersion: PROTOCOL_VERSION,
    };
  },
};
