/**
 * Selector generation utilities (runs in browser context)
 */

/**
 * Preferred ID attributes in order of priority
 */
const PREFERRED_ID_ATTRS = ['id', 'data-testid', 'data-test-id'];

/**
 * Max segment length for selectors
 */
const MAX_SEGMENT_LENGTH = 64;

/**
 * Separates the selector of a shadow host from a selector inside its (open) shadow root:
 * `host-sel >>> inner-sel`. A plain CSS selector cannot cross a shadow boundary, so every
 * resolver in handlers.ts splits on this and descends through `shadowRoot` per part.
 */
export const SHADOW_SEPARATOR = ' >>> ';

/**
 * Generate CSS selector for element
 * Prefers stable identifiers: id, data-testid, then falls back to nth-of-type.
 * An element inside an open shadow root gets its host's selector, SHADOW_SEPARATOR, then a
 * selector relative to that shadow root.
 *
 * Every uid action re-queries this selector and acts on the match, so it must match exactly
 * this element (T315: two inputs under sibling `div[data-testid]` wrappers got one selector
 * and a fill landed in the wrong field). `localCssSelector` therefore verifies its result and
 * falls back to a purely positional path when the readable one is not unique.
 */
export function generateCssSelector(el: Element): string {
  const root = el.getRootNode();
  if (typeof ShadowRoot !== 'undefined' && root instanceof ShadowRoot) {
    return generateCssSelector(root.host) + SHADOW_SEPARATOR + localCssSelector(el);
  }
  return localCssSelector(el);
}

function localCssSelector(el: Element): string {
  const readable = attributeCssSelector(el);
  return selectsOnly(readable, el) ? readable : positionalCssSelector(el);
}

/** True when `selector`, queried in el's own root, matches el and nothing else. */
export function selectsOnly(selector: string, el: Element): boolean {
  const root = el.getRootNode() as ParentNode;
  try {
    const found = root.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false; // a truncated or badly escaped segment is not a valid selector
  }
}

function countMatches(root: ParentNode, selector: string): number {
  try {
    return root.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

/**
 * Append `:nth-of-type(n)` to `step` when another child of el's parent also matches it.
 * An attribute such as `[data-testid="field"]` often repeats on every row of a form, so a
 * step built from one says nothing about WHICH sibling it is.
 */
function withSiblingIndex(el: Element, step: string): string {
  const siblings = el.parentNode ? Array.from((el.parentNode as ParentNode).children) : [];
  let alike = 0;
  for (const sibling of siblings) {
    try {
      if (sibling.matches(step)) alike++;
    } catch {
      return step;
    }
  }
  if (alike <= 1) return step;
  return step + `:nth-of-type(${nthOfType(el)})`;
}

function nthOfType(el: Element): number {
  let nth = 1;
  for (let sib = el.previousElementSibling; sib; sib = sib.previousElementSibling) {
    if (sib.nodeName === el.nodeName) nth++;
  }
  return nth;
}

function attributeCssSelector(el: Element): string {
  const root = el.getRootNode() as ParentNode;
  const path: string[] = [];
  let current: Element | null = el;

  while (current?.nodeType === Node.ELEMENT_NODE) {
    let selector = current.nodeName.toLowerCase();

    // Preferred ID attributes. One that is unique in the root ends the path; test IDs often
    // repeat in lists (and real pages duplicate ids), so a repeated one gets a sibling index
    // and the path continues to the parent for context.
    let idStep: string | null = null;
    for (const idAttr of PREFERRED_ID_ATTRS) {
      const value = current.getAttribute(idAttr);
      if (value) {
        idStep =
          idAttr === 'id'
            ? selector + '#' + CSS.escape(value)
            : selector + `[${idAttr}="${escapeCssAttributeValue(value)}"]`;
        break;
      }
    }

    if (idStep) {
      if (countMatches(root, idStep) === 1) {
        path.unshift(idStep);
        break; // unique in the root, stop here
      }
      path.unshift(withSiblingIndex(current, idStep));
      current = current.parentElement;
      continue;
    }

    // Check for aria-label + role combination (often stable)
    const ariaLabel = current.getAttribute('aria-label');
    const role = current.getAttribute('role');
    if (ariaLabel && role) {
      selector += `[role="${escapeCssAttributeValue(role)}"][aria-label="${escapeCssAttributeValue(ariaLabel)}"]`;
      path.unshift(withSiblingIndex(current, selector));
      // Continue to parent for context
      current = current.parentElement;
      continue;
    }

    // Fall back to nth-of-type
    const siblings = current.parentElement?.children;
    if (siblings && siblings.length > 1) {
      const nth = nthOfType(current);
      if (nth > 1 || siblings[0] !== current) {
        selector += `:nth-of-type(${nth})`;
      }
    }

    path.unshift(truncateSegment(selector));
    current = current.parentElement;

    // Stop at body
    if (current?.nodeName.toLowerCase() === 'body') {
      path.unshift('body');
      break;
    }
  }

  return path.join(' > ');
}

/**
 * Tag names and `:nth-of-type` only, every step a child combinator, anchored at `body` (or the
 * top of a shadow root). Unique under `body` by construction, and immune to attribute values
 * that repeat, get truncated or fail to escape. Less readable, so only used when the readable
 * selector fails `selectsOnly`.
 */
function positionalCssSelector(el: Element): string {
  const path: string[] = [];
  let current: Element | null = el;
  while (current) {
    const tag = current.localName;
    if (tag === 'body' || tag === 'html') {
      path.unshift(tag);
      break;
    }
    let step = CSS.escape(tag);
    const siblings = current.parentNode ? Array.from((current.parentNode as ParentNode).children) : [];
    if (siblings.filter((s) => s.localName === tag).length > 1) {
      step += `:nth-of-type(${nthOfType(current)})`;
    }
    path.unshift(step);
    current = current.parentElement;
  }
  return path.join(' > ');
}

/**
 * Generate XPath for element
 */
export function generateXPath(el: Element): string {
  // Check for ID first
  const id = el.id;
  if (id) {
    return `//*[@id="${escapeXPathValue(id)}"]`;
  }

  const path: string[] = [];
  let current: Element | null = el;

  while (current?.nodeType === Node.ELEMENT_NODE) {
    const tagName = current.nodeName.toLowerCase();

    // Count position among siblings of same tag
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.nodeName.toLowerCase() === tagName) {
        index++;
      }
      sibling = sibling.previousElementSibling;
    }

    // Only add index if there are multiple siblings of same type
    const parent = current.parentElement;
    let needsIndex = false;
    if (parent) {
      const siblingsOfSameType = Array.from(parent.children).filter(
        (child) => child.nodeName.toLowerCase() === tagName
      );
      needsIndex = siblingsOfSameType.length > 1;
    }

    const pathSegment = needsIndex ? `${tagName}[${index}]` : tagName;
    path.unshift(pathSegment);

    current = current.parentElement;

    // Stop at html
    if (current?.nodeName.toLowerCase() === 'html') {
      path.unshift('html');
      break;
    }
  }

  return '/' + path.join('/');
}

/**
 * Escape CSS attribute value
 */
function escapeCssAttributeValue(value: string): string {
  return value.replace(/"/g, '\\' + '"').substring(0, MAX_SEGMENT_LENGTH);
}

/**
 * Escape XPath value
 */
function escapeXPathValue(value: string): string {
  // Simple escape - handle quotes
  if (value.indexOf('"') === -1) {
    return value;
  }
  if (value.indexOf("'") === -1) {
    return value;
  }
  // Contains both quotes - use concat
  const parts = value.split('"').map((part, idx, arr) => {
    if (idx === arr.length - 1) {
      return part ? `"${part}"` : '';
    }
    return part ? `"${part}",'"'` : '"\'"';
  });
  return `concat(${parts.filter((p) => p).join(',')})`;
}

/**
 * Truncate selector segment
 */
function truncateSegment(segment: string): string {
  if (segment.length <= MAX_SEGMENT_LENGTH) {
    return segment;
  }
  return segment.substring(0, MAX_SEGMENT_LENGTH);
}
