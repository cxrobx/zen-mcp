// Zen Space placement for the tabs this MCP opens.
//
// Zen exposes no space id to WebExtensions, and the only space placement it offers that
// leaves the user's view alone is Space Routing, which matches URLs. A tab's container is
// invisible to those rules - a Google Doc looks the same in every jar. So a container tab
// opens first at a marker naming its container, one generated rule per container
// (scripts/gen-space-markers.mjs) sends that marker to the space bound to the container,
// and only then does the tab load its real URL. Measured on Zen 1.22.1b: a background tab
// is filed without switching the user's view, the real load stays in that space, and the
// marker does not survive in the tab's history.
//
// The trailing ";" is load-bearing. Zen's "contains" rules are substring matches, and
// without a terminator the rule for firefox-container-1 would also claim containers 10-19.

const MARKER_KEY = "zen-space=";
const MARKER_URL_PREFIX = `about:blank#${MARKER_KEY}`;

/** The Space Routing "contains" reference that files this container's tabs into its space. */
export function spaceMarkerReference(cookieStoreId: string): string {
  return `${MARKER_KEY}${cookieStoreId};`;
}

/** Where a container tab opens before it loads its real URL. */
export function spaceMarkerUrl(cookieStoreId: string): string {
  return `about:blank#${spaceMarkerReference(cookieStoreId)}`;
}

/** A tab still sitting on its marker has not loaded anything yet. */
export function isSpaceMarkerUrl(url: string | undefined | null): boolean {
  return typeof url === "string" && url.startsWith(MARKER_URL_PREFIX);
}

/** Every reference this MCP generates starts with this, so generated rules are recognizable. */
export const SPACE_MARKER_NAMESPACE = "zen-space";
