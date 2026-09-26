// Masks credential-shaped text in the page for the length of one screenshot.
//
// Text redaction cannot reach an image: a screenshot of Stripe's older API-keys layout put
// four full test keys into the transcript (2026-09-25). So before captureTab the page itself
// is rewritten with the same masker the server applies to text, and put back right after.
//
// Runs in the extension's ISOLATED world, so the page cannot see or call it, and the saved
// originals never sit anywhere the page can read. Three passes:
//   1. text nodes whose data holds a key get the masked data;
//   2. <input>/<textarea> values get the masked value (set through the native setter, which is
//      what an isolated-world write is, so a React value tracker is left holding the original
//      and the restore is invisible to it);
//   3. a key split across elements (a styled prefix span, say) is found by testing the
//      textContent of the few ancestors above a suspicious text node, and that ancestor is
//      blurred instead.
// Restore only puts back what still holds the masked value: if the page re-rendered a node in
// between, the page's version wins.
import { hasCredentials, maskCredentials } from "@zen-mcp/shared/credential-redact";

type Undo = () => void;

declare global {
  interface Window {
    __zenExtMcpMaskCredentials?: () => number;
    __zenExtMcpRestoreCredentials?: () => number;
  }
}

// A text node this short can't hold a key on its own but may start one.
const PREFIX_HINT = /(?:sk_|rk_|whsec_|gh[pousr]_|github_pat_|xox[abpr]-|AKIA|PRIVATE KEY|secret|token|key)/i;
const SPLIT_ANCESTOR_DEPTH = 3;

let undo: Undo[] = [];

function maskTextNode(node: Text): boolean {
  const original = node.data;
  if (!hasCredentials(original)) return false;
  const masked = maskCredentials(original);
  node.data = masked;
  undo.push(() => {
    if (node.data === masked) node.data = original;
  });
  return true;
}

function maskField(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  if (el instanceof HTMLInputElement && el.type === "password") return false; // already dots
  const original = el.value;
  if (!original || !hasCredentials(original)) return false;
  const masked = maskCredentials(original);
  let selection: [number | null, number | null] | null = null;
  try {
    selection = [el.selectionStart, el.selectionEnd];
  } catch {
    // Some input types have no selection.
  }
  el.value = masked;
  undo.push(() => {
    if (el.value !== masked) return;
    el.value = original;
    if (selection && selection[0] !== null && selection[1] !== null) {
      try {
        el.setSelectionRange(selection[0], selection[1]);
      } catch {
        // ignore
      }
    }
  });
  return true;
}

function blurElement(el: HTMLElement): void {
  const had = el.hasAttribute("style");
  const before = el.getAttribute("style");
  el.style.setProperty("filter", "blur(8px)", "important");
  undo.push(() => {
    if (had && before !== null) el.setAttribute("style", before);
    else el.removeAttribute("style");
  });
}

function walk(root: Document | ShadowRoot, count: { n: number }, blurred: Set<Element>): void {
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
  );
  const suspects: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text;
      if (maskTextNode(text)) count.n += 1;
      else if (PREFIX_HINT.test(text.data)) suspects.push(text);
      continue;
    }
    const el = node as Element;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (maskField(el)) count.n += 1;
    }
    if (el.shadowRoot) walk(el.shadowRoot, count, blurred);
  }
  // Pass 3, after every whole-node mask, so an ancestor only matches on a genuinely split key.
  for (const text of suspects) {
    let el = text.parentElement;
    for (let depth = 0; el && depth < SPLIT_ANCESTOR_DEPTH; depth += 1, el = el.parentElement) {
      if (blurred.has(el)) break;
      if (el === document.body || el === document.documentElement) break;
      if (hasCredentials(el.textContent ?? "")) {
        if (el instanceof HTMLElement) {
          blurElement(el);
          blurred.add(el);
          count.n += 1;
        }
        break;
      }
    }
  }
}

// Two sessions can screenshot the same tab at once. The page stays masked until the LAST
// capture restores it, and a capture that never comes back (the background died mid-call)
// unmasks the page on its own after a few seconds rather than leaving it rewritten.
let depth = 0;
let failsafe: ReturnType<typeof setTimeout> | undefined;
const FAILSAFE_MS = 15_000;

function runUndo(): number {
  const pending = undo;
  undo = [];
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    try {
      pending[i]!();
    } catch {
      // A node the page removed; nothing to put back.
    }
  }
  return pending.length;
}

function maskAll(): number {
  depth += 1;
  // Already-masked nodes don't match again, so a second walk only picks up what is new.
  const count = { n: 0 };
  walk(document, count, new Set());
  if (failsafe !== undefined) clearTimeout(failsafe);
  failsafe = setTimeout(() => {
    depth = 0;
    failsafe = undefined;
    runUndo();
  }, FAILSAFE_MS);
  return count.n;
}

function restoreAll(): number {
  depth = Math.max(0, depth - 1);
  if (depth > 0) return 0;
  if (failsafe !== undefined) clearTimeout(failsafe);
  failsafe = undefined;
  return runUndo();
}

// Injected once per screenshot; only the first copy registers, so a re-injection can't orphan
// the undo list of a capture still in flight.
if (!window.__zenExtMcpMaskCredentials) {
  window.__zenExtMcpMaskCredentials = maskAll;
  window.__zenExtMcpRestoreCredentials = restoreAll;
}
