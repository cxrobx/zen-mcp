import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

interface ReadResult {
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

declare global {
  interface Window {
    __zenReadability?: () => ReadResult;
  }
}

function runReadability(): ReadResult {
  try {
    const clone = document.cloneNode(true) as Document;
    clone.querySelectorAll("input, textarea").forEach((el) => el.remove());
    const article = new Readability(clone, {}).parse();
    if (!article || !article.content) {
      return { ok: false, reason: "no_article" };
    }
    const turndown = new TurndownService({
      headingStyle: "atx",
      bulletListMarker: "-",
      codeBlockStyle: "fenced",
      emDelimiter: "_",
      linkStyle: "inlined",
    });
    turndown.remove(["script", "style", "noscript", "iframe"]);
    const markdown = turndown.turndown(article.content);
    const result: ReadResult = { ok: true, markdown };
    if (article.title) result.title = article.title;
    if (article.byline) result.byline = article.byline;
    if (article.excerpt) result.excerpt = article.excerpt;
    if (article.siteName) result.siteName = article.siteName;
    if (typeof article.length === "number") result.length = article.length;
    return result;
  } catch (e) {
    return { ok: false, reason: "error", message: (e as Error).message };
  }
}

window.__zenReadability = runReadability;
