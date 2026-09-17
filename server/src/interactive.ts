import type { SnapshotNode, SnapshotUidEntry } from "@zen-mcp/shared";

/**
 * The actionable subset of a DOM snapshot, one line per element.
 *
 * A full take_snapshot is a tree of every relevant node - headings, sections, text
 * containers - and on a heavy admin SPA that is ~13k tokens, mostly chrome. Deciding what
 * to click needs far less: the element, what kind it is, what it says, and which row or
 * region it sits in. The row context is not decoration: UID order is DOM order, so two
 * "Edit" buttons are indistinguishable without it (the 2026-08-24 Courses Plus near-miss).
 *
 * Pure: it reads a snapshot the extension already produced, so the UIDs stay valid for
 * click_by_uid and nothing here needs an extension release.
 *
 * Field values are never read. An input's value is whatever someone typed into it.
 */

export const INTERACTIVE_DEFAULT_LIMIT = 200;
// Jev's Choice primitive rejects more than 255 options (measured: HTTP 400 "Must have at
// most 255 choices"); navigate_goal reserves one slot for "none".
export const INTERACTIVE_MAX_LIMIT = 254;

const LABEL_MAX = 80;
const CONTEXT_MAX = 60;
const HEADINGS_MAX = 5;

const ROLE_KINDS = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "checkbox",
  "radio",
  "switch",
  "option",
  "combobox",
  "textbox",
  "searchbox",
  "treeitem",
  "slider",
  "spinbutton",
]);

// INTERACTIVE_TAGS in the extension includes media and iframes, which are not controls.
const MEDIA_TAGS = new Set(["img", "video", "audio", "iframe", "svg", "canvas"]);

const ROW_TAGS = new Set(["tr", "li"]);
const ROW_ROLES = new Set(["row", "listitem", "article"]);

const REGION_TAGS = new Set(["nav", "header", "footer", "aside", "form", "dialog"]);
const REGION_ROLES = new Set([
  "navigation",
  "dialog",
  "alertdialog",
  "menu",
  "menubar",
  "tablist",
  "toolbar",
  "form",
  "search",
  "banner",
  "contentinfo",
  "complementary",
]);
// Too generic to be worth naming unless the page gave them a label.
const NAMED_ONLY_REGIONS = new Set(["section", "region", "tabpanel", "group"]);

export interface InteractiveElement {
  uid: string;
  kind: string;
  label: string;
  context: string;
  href?: string;
  /** The link points at a different host than the page. */
  offHost?: boolean;
  /** aria-selected is true: the current tab, option, or row. */
  selected?: boolean;
  frameId?: number;
  /** Another element on the page has the same kind and label; only context tells them apart. */
  duplicate: boolean;
}

export interface InteractiveCollection {
  elements: InteractiveElement[];
  /** Every interactive element found, before the limit. */
  total: number;
  truncated: boolean;
  /** The first few h1-h3 labels, in DOM order - a cheap "where am I" signal. */
  headings: string[];
}

export interface CollectOptions {
  limit?: number;
  /** The page URL, so same-host hrefs can be shown as bare paths. */
  pageUrl?: string;
}

function clean(value: string | undefined): string {
  return value ? value.replace(/\s+/g, " ").trim() : "";
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function roleOf(node: SnapshotNode): string {
  return node.role ? node.role.trim().toLowerCase() : "";
}

export function kindOf(node: SnapshotNode): string | null {
  if (node.computed?.visible === false) return null;
  const role = roleOf(node);
  if (role && ROLE_KINDS.has(role)) return role;
  switch (node.tag) {
    case "a":
      return "link";
    case "button":
    case "summary":
      return "button";
    case "select":
      return "combobox";
    case "textarea":
      return "textbox";
    case "input":
      // The snapshot carries no `type` attribute, so a checkbox and a text field both land
      // here. A role, when the page set one, was already honored above.
      return "input";
  }
  if (node.computed?.interactive === true && !MEDIA_TAGS.has(node.tag)) return "clickable";
  return null;
}

function isFormField(node: SnapshotNode): boolean {
  return node.tag === "input" || node.tag === "textarea" || node.tag === "select";
}

/**
 * First text found in a subtree, not descending into a node once it yielded text (its own
 * text already includes what its children say). Returns "" when the subtree is silent.
 */
function subtreeText(node: SnapshotNode, max: number, skip?: (n: SnapshotNode) => boolean): string {
  const parts: string[] = [];
  let length = 0;
  const walk = (n: SnapshotNode): boolean => {
    for (const child of n.children) {
      if (skip?.(child)) continue;
      const text = isFormField(child) ? clean(child.name) : clean(child.name) || clean(child.text);
      if (text) {
        parts.push(text);
        length += text.length + 1;
        if (length >= max) return true;
        continue;
      }
      if (walk(child)) return true;
    }
    return false;
  };
  walk(node);
  return parts.join(" ");
}

export function labelOf(node: SnapshotNode): string {
  // Snapshot names come from aria-label, <label for>, placeholder, title, alt, or a
  // link/button's DIRECT text only - so <a><span>Webhooks</span></a> arrives unnamed and
  // the label has to be recovered from descendants.
  const direct = clean(node.name) || (isFormField(node) ? "" : clean(node.text));
  if (direct) return clip(direct, LABEL_MAX);
  if (isFormField(node)) return "";
  return clip(subtreeText(node, LABEL_MAX), LABEL_MAX);
}

function isRow(node: SnapshotNode): boolean {
  return ROW_TAGS.has(node.tag) || ROW_ROLES.has(roleOf(node));
}

function regionLabel(node: SnapshotNode): string | null {
  const role = roleOf(node);
  const name = clean(node.name);
  const word = role && (REGION_ROLES.has(role) || NAMED_ONLY_REGIONS.has(role)) ? role : node.tag;
  if (REGION_TAGS.has(node.tag) || REGION_ROLES.has(role)) {
    return name ? `${word} "${clip(name, CONTEXT_MAX)}"` : word;
  }
  if ((NAMED_ONLY_REGIONS.has(node.tag) || NAMED_ONLY_REGIONS.has(role)) && name) {
    return `${word} "${clip(name, CONTEXT_MAX)}"`;
  }
  return null;
}

function displayHref(
  href: string | undefined,
  pageUrl: string | undefined,
): { text: string; offHost: boolean } | undefined {
  if (!href) return undefined;
  try {
    const target = new URL(href, pageUrl);
    if (target.protocol !== "http:" && target.protocol !== "https:") return undefined;
    // Query strings and fragments carry tokens and ids far more often than meaning.
    const page = pageUrl ? new URL(pageUrl) : null;
    return page && page.host === target.host
      ? { text: target.pathname, offHost: false }
      : { text: `${target.host}${target.pathname}`, offHost: page !== null };
  } catch {
    return undefined;
  }
}

export function collectInteractive(
  tree: SnapshotNode | null,
  uidMap: SnapshotUidEntry[],
  options: CollectOptions = {},
): InteractiveCollection {
  const limit = options.limit ?? INTERACTIVE_DEFAULT_LIMIT;
  const frames = new Map(uidMap.map((entry) => [entry.uid, entry.frameId]));
  const found: InteractiveElement[] = [];
  const headings: string[] = [];
  const rowLabels = new Map<string, string>();

  const rowLabelOf = (row: SnapshotNode): string => {
    const cached = rowLabels.get(row.uid);
    if (cached !== undefined) return cached;
    // The row's own words, not its controls': "ACH Direct Debit", not "Edit".
    const label = clip(subtreeText(row, CONTEXT_MAX, (n) => kindOf(n) !== null), CONTEXT_MAX);
    rowLabels.set(row.uid, label);
    return label;
  };

  const walk = (node: SnapshotNode, row: SnapshotNode | null, region: string | null): void => {
    if (/^h[1-3]$/.test(node.tag) && headings.length < HEADINGS_MAX) {
      const heading = clean(node.name) || clean(node.text);
      if (heading) headings.push(clip(heading, CONTEXT_MAX));
    }
    const kind = kindOf(node);
    if (kind) {
      const rowText = row ? rowLabelOf(row) : "";
      const context = [rowText ? `row "${rowText}"` : "", region ?? ""].filter(Boolean).join(" in ");
      const element: InteractiveElement = {
        uid: node.uid,
        kind,
        label: labelOf(node),
        context,
        duplicate: false,
      };
      // Any control can carry an href (a button wrapping an anchor), not only links.
      const href = displayHref(node.href, options.pageUrl);
      if (href) {
        element.href = href.text;
        if (href.offHost) element.offHost = true;
      }
      if (node.aria?.selected === true) element.selected = true;
      const frameId = frames.get(node.uid);
      if (typeof frameId === "number" && frameId !== 0) element.frameId = frameId;
      found.push(element);
    }
    const nextRow = isRow(node) ? node : row;
    const nextRegion = regionLabel(node) ?? region;
    for (const child of node.children) walk(child, nextRow, nextRegion);
  };
  if (tree) walk(tree, null, null);

  const seen = new Map<string, number>();
  for (const el of found) {
    if (!el.label) continue;
    const key = `${el.kind}\u0000${el.label}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const el of found) {
    if (el.label && (seen.get(`${el.kind}\u0000${el.label}`) ?? 0) > 1) el.duplicate = true;
  }

  return {
    elements: found.slice(0, Math.max(0, limit)),
    total: found.length,
    truncated: found.length > limit,
    headings,
  };
}

export function formatInteractiveLine(el: InteractiveElement): string {
  const parts = [el.uid, el.kind, JSON.stringify(el.label)];
  if (el.href) parts.push(`-> ${el.href}`);
  if (el.context) parts.push(`in ${el.context}`);
  if (el.selected) parts.push("(selected)");
  if (el.frameId !== undefined) parts.push(`frame=${el.frameId}`);
  if (el.duplicate) parts.push("(same label elsewhere)");
  return parts.join(" ");
}
