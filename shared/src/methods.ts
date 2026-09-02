export const Methods = {
  ContainersList: "containers.list",
  PagesList: "pages.list",
  PagesGet: "pages.get",
  PagesNew: "pages.new",
  PagesNavigate: "pages.navigate",
  PagesSelect: "pages.select",
  PagesClose: "pages.close",
  PagesNavigateHistory: "pages.navigateHistory",
  PagesScreenshot: "pages.screenshot",
  DomTakeSnapshot: "dom.takeSnapshot",
  DomClearSnapshot: "dom.clearSnapshot",
  DomClick: "dom.click",
  DomHover: "dom.hover",
  DomFill: "dom.fill",
  DomFillForm: "dom.fillForm",
  DomDrag: "dom.drag",
  DomResolveUidToSelector: "dom.resolveUidToSelector",
  DomEvaluate: "dom.evaluate",
  DomGetPageText: "dom.getPageText",
  DomReadPage: "dom.readPage",
  DomClickByLocator: "dom.clickByLocator",
  DomHoverByLocator: "dom.hoverByLocator",
  DomFillByLocator: "dom.fillByLocator",
  DomTypeByLocator: "dom.typeByLocator",
  DomDragByLocator: "dom.dragByLocator",
  DomSelectOptionByLocator: "dom.selectOptionByLocator",
  DomPressKey: "dom.pressKey",
  DomScroll: "dom.scroll",
  CookiesGet: "cookies.get",
  CookiesSet: "cookies.set",
  CookiesClear: "cookies.clear",
  StorageGet: "storage.get",
  StorageSet: "storage.set",
  StorageClear: "storage.clear",
  InfoGet: "info.get",
  NavMemoryQuery: "navMemory.query",
  NavMemoryRecordEvents: "navMemory.recordEvents",
  NavMemoryStats: "navMemory.stats",
  NavMemoryForget: "navMemory.forget",
  NavMemoryEtlNow: "navMemory.etlNow",
} as const;

export type MethodName = (typeof Methods)[keyof typeof Methods];

export interface FirefoxContainer {
  cookieStoreId: string;
  name: string;
  color: string;
  icon: string;
}

export interface ContainersListResult {
  containers: FirefoxContainer[];
}

export interface PageInfo {
  tabId: number;
  windowId: number;
  index: number;
  url: string;
  title: string;
  active: boolean;
  cookieStoreId: string;
  containerName: string | null;
  /**
   * False when the tab lives in a Zen workspace other than the active one. Such a tab is
   * absent from browser.tabs.query() but still reachable by tabId (tabs.get, scripting,
   * captureTab, tabs.update all resolve ids without a workspace filter). Absent means true:
   * an older extension only ever reports the active workspace.
   */
  inActiveWorkspace?: boolean;
  /** True when the tab is unloaded (discarded); DOM tools need a navigate/select first. */
  discarded?: boolean;
}

export interface PagesListParams {
  /**
   * Also enumerate tabs in other Zen workspaces. They are found by probing tab ids, not by
   * query, and come back flagged inActiveWorkspace: false with a stale index.
   */
  includeHidden?: boolean;
}

export interface PagesListResult {
  pages: PageInfo[];
}

export interface GetPageParams {
  tabId: number;
}

/** page is null when no tab with that id exists in any workspace. */
export interface GetPageResult {
  page: PageInfo | null;
}

export interface NewPageParams {
  url: string;
  cookieStoreId?: string;
  active?: boolean;
}

export interface NewPageResult {
  tabId: number;
  windowId: number;
  url: string;
  cookieStoreId: string;
  containerName: string | null;
}

export interface NavigatePageParams {
  tabId: number;
  url: string;
}

export interface SelectPageParams {
  tabId: number;
}

export interface ClosePageParams {
  tabId: number;
}

export type NavigateHistoryDirection = "back" | "forward";

export interface NavigateHistoryParams {
  tabId: number;
  direction: NavigateHistoryDirection;
}

export interface TabIdResult {
  tabId: number;
}

export interface SnapshotUidEntry {
  uid: string;
  css: string;
  xpath?: string;
  frameId?: number;
}

export interface SnapshotNode {
  uid: string;
  tag: string;
  role?: string;
  name?: string;
  value?: string;
  href?: string;
  src?: string;
  text?: string;
  isIframe?: boolean;
  frameSrc?: string;
  crossOrigin?: boolean;
  aria?: Record<string, unknown>;
  computed?: Record<string, unknown>;
  children: SnapshotNode[];
}

export interface TakeSnapshotParams {
  tabId: number;
  selector?: string;
  includeAll?: boolean;
  includeIframes?: boolean;
  maxBytes?: number;
  cursor?: string;
}

export interface TakeSnapshotResult {
  tabId: number;
  snapshotId: number;
  tree: SnapshotNode | null;
  uidMap: SnapshotUidEntry[];
  truncated: boolean;
  selectorError?: string;
}

export interface ClearSnapshotParams {
  tabId: number;
}

export interface UidActionParams {
  tabId: number;
  uid: string;
}

export interface FillParams extends UidActionParams {
  value: string;
}

export interface FillFormParams {
  tabId: number;
  fields: Array<{ uid: string; value: string }>;
}

export interface DragParams {
  tabId: number;
  fromUid: string;
  toUid: string;
}

export interface ResolveUidResult {
  uid: string;
  css: string;
  xpath?: string;
}

export interface EvaluateScriptParams {
  tabId: number;
  code: string;
  maxBytes?: number;
  cursor?: string;
}

export interface EvaluateScriptResult {
  result: unknown;
}

export interface ScreenshotPageParams {
  tabId: number;
  format?: "jpeg" | "png";
  quality?: number;
}

export interface ScreenshotPageResult {
  tabId: number;
  dataUrl: string;
}

export interface GetPageTextParams {
  tabId: number;
  selector?: string;
}

export interface GetPageTextResult {
  text: string;
}

export interface ReadPageParams {
  tabId: number;
}

export interface ReadPageResult {
  ok: boolean;
  reason?: string;
  message?: string;
  title?: string;
  byline?: string;
  excerpt?: string;
  siteName?: string;
  length?: number;
  markdown?: string;
}

export type LocatorSpec =
  | { kind: "css"; selector: string }
  | { kind: "xpath"; expression: string };

export interface LocatorParams {
  tabId: number;
  locator: LocatorSpec;
  timeoutMs?: number;
}

export interface LocatorActionResult {
  tabId: number;
  matchedTag?: string;
}

export interface ActionFeedback {
  url: string;
  title: string;
  activeElement?: {
    tag: string;
    name?: string;
  };
  navigated: boolean;
}

export interface InteractionResult extends TabIdResult {
  matchedTag?: string;
  feedback?: ActionFeedback;
}

export interface FillByLocatorParams extends LocatorParams {
  value: string;
}

export interface TypeByLocatorParams extends LocatorParams {
  text: string;
  delayMs?: number;
  clearFirst?: boolean;
}

export interface DragByLocatorParams {
  tabId: number;
  from: LocatorSpec;
  to: LocatorSpec;
  timeoutMs?: number;
}

export type SelectOptionBy = "value" | "label" | "index";

export interface SelectOptionByLocatorParams extends LocatorParams {
  by: SelectOptionBy;
  value: string;
}

export interface SelectOptionResult {
  ok: boolean;
  reason?: string;
  tag?: string;
  value?: string;
  label?: string;
  feedback?: ActionFeedback;
}

export type PressKeyTarget =
  | { kind: "locator"; locator: LocatorSpec }
  | { kind: "active" };

export interface PressKeyParams {
  tabId: number;
  target: PressKeyTarget;
  keys: string;
  timeoutMs?: number;
}

export interface ScrollParams {
  tabId: number;
  x?: number;
  y?: number;
  pages?: number;
  locator?: LocatorSpec;
  uid?: string;
  timeoutMs?: number;
}

export interface ScrollResult {
  tabId: number;
  x: number;
  y: number;
  atTop: boolean;
  atBottom: boolean;
  atLeft: boolean;
  atRight: boolean;
}

export interface CookieEntry {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expirationDate?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "no_restriction" | "lax" | "strict";
  storeId?: string;
}

export interface GetCookiesParams {
  url?: string;
  name?: string;
  domain?: string;
  storeId?: string;
  maxBytes?: number;
  cursor?: string;
}

export interface GetCookiesResult {
  cookies: CookieEntry[];
}

export interface SetCookiesParams {
  cookies: Array<CookieEntry & { url: string }>;
}

export interface SetCookiesResult {
  set: number;
  failures?: Array<{ name: string; domain?: string; reason: string }>;
}

export interface ClearCookiesParams {
  url?: string;
  name?: string;
  domain?: string;
  storeId?: string;
}

export interface ClearCookiesResult {
  deleted: number;
  failures?: Array<{ name: string; domain?: string; reason: string }>;
}

export type StorageKind = "local" | "session";

export interface StorageGetParams {
  tabId: number;
  kind: StorageKind;
  keys?: string[];
  maxBytes?: number;
  cursor?: string;
}

export interface StorageGetResult {
  items: Record<string, string | null>;
}

export interface StorageSetParams {
  tabId: number;
  kind: StorageKind;
  items: Record<string, string>;
}

export interface StorageSetResult {
  written: number;
}

export interface StorageClearParams {
  tabId: number;
  kind: StorageKind;
  keys?: string[];
}

export interface StorageClearResult {
  removed: number;
  cleared: boolean;
}

export interface InfoGetResult {
  extensionId: string;
  extensionVersion: string;
  userAgent: string;
  platform: string;
  windowCount: number;
  tabCount: number;
  containerCount: number;
  protocolVersion: number;
}
