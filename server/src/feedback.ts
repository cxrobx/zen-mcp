import type { InteractionResult } from "@zen-mcp/shared";

export function truncateOneLine(value: string | undefined, maxLen: number): string {
  if (!value) return "";
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen - 3) + "...";
}

export interface FeedbackOptions {
  /** The action was a click, so it may have started a page load that has not committed yet. */
  click?: boolean;
}

// The extension reads the tab the instant the action returns (`collectFeedback`), which is
// before a full page load commits: a click on a real link reports the page it LEFT, with
// navigated=false. Printed as a bare `page:` line that reads as "the click did nothing", and a
// model that believes it clicks again - on a write surface, a double submit. So a click's line
// says when it was read, and an unchanged one says why that proves nothing yet. The note is
// conditional on purpose: most clicks are buttons that never navigate, and an unconditional
// "wait_for" after each of them would buy a model turn per click for nothing.
export function feedbackLine(r: InteractionResult, opts: FeedbackOptions = {}): string {
  const fb = r.feedback;
  // The click still reached the element, so this is a note, not a failure - but it is the
  // explanation for a click that appears to do nothing.
  const covered = r.occludedBy
    ? `\ncovered by ${truncateOneLine(r.occludedBy, 80)} - the element got the click, but a page in a modal state may ignore it; dismiss the overlay if nothing happened`
    : "";
  // Not truncated: a cut URL is useless, and the caller's next step is to open this one.
  const newTab = r.opensNewTab
    ? `\nopens in a new tab: ${r.opensNewTab} - a synthetic click is usually stopped by the popup blocker, so if list_pages shows no new tab, open_url that address`
    : "";
  if (!fb) return `${covered}${newTab}`;
  const active = fb.activeElement
    ? ` active=${fb.activeElement.tag}${fb.activeElement.name ? ` name="${truncateOneLine(fb.activeElement.name, 60)}"` : ""}`
    : "";
  const label = opts.click ? "page right after the click" : "page";
  const pending =
    opts.click && !fb.navigated
      ? "\nurl unchanged so far - if this click should load a new page, that load would not show here yet, so wait_for its url or text before concluding it did nothing"
      : "";
  return `\n${label}: ${fb.title ? `"${truncateOneLine(fb.title, 80)}" ` : ""}${fb.url}${fb.navigated ? " navigated" : ""}${active}${pending}${covered}${newTab}`;
}
