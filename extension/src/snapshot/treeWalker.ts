/**
 * Tree walker with iframe support (runs in browser context)
 */

import type { SnapshotNode, UidEntry } from './types.js';
import { isRelevant, isVisible } from './elementCollector.js';
import {
  getElementName,
  getTextContent,
  getAriaAttributes,
  getComputedProperties,
} from './attributeCollector.js';
import { generateCssSelector, generateXPath } from './selectorGenerator.js';

/**
 * Configuration
 */
// Framework-heavy applications (Google Admin, Azure Portal) routinely nest useful
// controls more than 30 elements deep. This is a traversal safety limit, not a UI
// hierarchy preference: stopping at 10 made whole panels disappear even though
// document.body.innerText could read them.
const MAX_DEPTH = 100;
const MAX_NODES = 5000;

/**
 * Tree walker options
 */
export interface TreeWalkerOptions {
  includeAll?: boolean;
  includeIframes?: boolean;
}

/**
 * Tree walker result
 */
export interface TreeWalkerResult {
  tree: SnapshotNode | null;
  uidMap: UidEntry[];
  truncated: boolean;
}

/**
 * Internal walk result with bubble-up support
 */
interface WalkResult {
  node: SnapshotNode | null;
  relevantChildren: SnapshotNode[];
}

/**
 * Walk DOM tree and collect snapshot
 */
export function walkTree(
  rootElement: Element,
  snapshotId: number,
  options: TreeWalkerOptions = {}
): TreeWalkerResult {
  const { includeAll = false, includeIframes = true } = options;

  let counter = 0;
  const uidMap: UidEntry[] = [];
  let truncated = false;

  function getSerializableProperty(el: HTMLElement, key: "value" | "href" | "src"): string | undefined {
    try {
      const value = (el as unknown as Record<string, unknown>)[key];
      if (typeof value === "string") return value || undefined;
      if (typeof value === "number" || typeof value === "boolean") return String(value);
    } catch {
      // Custom-element getters may throw or return page-owned objects. Snapshot
      // results must stay structured-clonable across the extension boundary.
    }
    return undefined;
  }

  function walk(el: Element, depth: number): WalkResult {
    // Check limits
    if (depth > MAX_DEPTH) {
      truncated = true;
      return { node: null, relevantChildren: [] };
    }

    if (counter >= MAX_NODES) {
      truncated = true;
      return { node: null, relevantChildren: [] };
    }

    // Check relevance (except root)
    const tag = el.tagName.toLowerCase();
    const isRoot = tag === 'body' || tag === 'html';

    // Determine if element is relevant based on mode
    let elementIsRelevant: boolean;
    if (includeAll) {
      // Include all mode: only check visibility
      elementIsRelevant = isRoot || isVisible(el);
    } else {
      // Standard mode: use full relevance filter
      elementIsRelevant = isRoot || isRelevant(el);
    }

    // Always walk children first (bubble-up pattern)
    const childResults: SnapshotNode[] = [];

    // Handle iframes
    if (tag === 'iframe' && includeIframes && elementIsRelevant) {
      try {
        const iframe = el as HTMLIFrameElement;
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;

        if (iframeDoc?.body) {
          // Same-origin iframe - traverse it
          const iframeResult = walk(iframeDoc.body, depth + 1);
          if (iframeResult.node) {
            iframeResult.node.isIframe = true;
            iframeResult.node.frameSrc = iframe.src;
            childResults.push(iframeResult.node);
          }
        }
      } catch {
        // Cross-origin error - will be handled when creating node
      }
    } else {
      // Walk regular children
      for (let i = 0; i < el.children.length; i++) {
        if (counter >= MAX_NODES) {
          truncated = true;
          break;
        }

        const child = el.children[i];
        if (!child) {
          continue;
        }

        const childResult = walk(child, depth + 1);

        if (childResult.node) {
          // Child is relevant, include it
          childResults.push(childResult.node);
        } else if (childResult.relevantChildren.length > 0) {
          // Child is not relevant but has relevant descendants - bubble them up
          childResults.push(...childResult.relevantChildren);
        }
      }
      // Open shadow root: its controls are what the page renders (web components, React apps
      // mounted in shadow DOM like Impact's), and el.children never reaches them. Closed roots
      // are unreachable by design. Selectors for these nodes carry ' >>> ' (selectorGenerator).
      const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (shadow) {
        for (let i = 0; i < shadow.children.length; i++) {
          if (counter >= MAX_NODES) {
            truncated = true;
            break;
          }
          const child = shadow.children[i];
          if (!child || child.tagName === 'STYLE' || child.tagName === 'SCRIPT') continue;
          const childResult = walk(child, depth + 1);
          if (childResult.node) childResults.push(childResult.node);
          else if (childResult.relevantChildren.length > 0) childResults.push(...childResult.relevantChildren);
        }
      }
    }

    // Now decide if THIS element should be included
    if (!elementIsRelevant) {
      // Element is not relevant, but pass up its relevant children
      return { node: null, relevantChildren: childResults };
    }

    // Element IS relevant - create node
    const uid = `${snapshotId}_${counter++}`;
    const css = generateCssSelector(el);
    const xpath = generateXPath(el);

    uidMap.push({ uid, css, xpath });

    // Collect attributes
    const htmlEl = el as HTMLElement;
    const roleAttr = el.getAttribute('role');
    const nameAttr = getElementName(el);
    const textAttr = tag === "textarea" ? undefined : getTextContent(el);
    // A password may already be type=text before our first inspection (eye toggle).
    // Never serialize editable input values; type/history heuristics cannot prove safety.
    const valueAttr = tag === "input" || tag === "textarea"
      ? undefined : getSerializableProperty(htmlEl, "value");
    const hrefAttr = getSerializableProperty(htmlEl, "href");
    const srcAttr = getSerializableProperty(htmlEl, "src");
    const ariaAttr = getAriaAttributes(el);
    const computedAttr = getComputedProperties(el);

    const node: SnapshotNode = {
      uid,
      tag,
      ...(roleAttr && { role: roleAttr }),
      ...(nameAttr && { name: nameAttr }),
      ...(valueAttr && { value: valueAttr }),
      ...(hrefAttr && { href: hrefAttr }),
      ...(srcAttr && { src: srcAttr }),
      ...(textAttr && { text: textAttr }),
      ...(ariaAttr && { aria: ariaAttr }),
      ...(computedAttr && { computed: computedAttr }),
      children: childResults,
    };

    // Special handling for cross-origin iframes
    if (tag === 'iframe' && includeIframes) {
      try {
        const iframe = el as HTMLIFrameElement;
        const iframeDoc = iframe.contentDocument || iframe.contentWindow?.document;

        if (!iframeDoc?.body) {
          // Cross-origin or no body - placeholder
          node.isIframe = true;
          node.frameSrc = iframe.src;
          node.crossOrigin = true;
        }
      } catch {
        // Cross-origin error - add placeholder
        node.isIframe = true;
        node.frameSrc = (el as HTMLIFrameElement).src;
        node.crossOrigin = true;
      }
    }

    return { node, relevantChildren: [] };
  }

  const result = walk(rootElement, 0);

  return {
    tree: result.node,
    uidMap,
    truncated,
  };
}
