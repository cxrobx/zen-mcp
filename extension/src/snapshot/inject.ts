import {
  type CreateSnapshotOptions,
  type CreateSnapshotResult,
} from "./types.js";
import { walkTree, type TreeWalkerOptions } from "./treeWalker.js";

declare global {
  interface Window {
    __zenExtMcpCreateSnapshot?: (
      snapshotId: number,
      options?: CreateSnapshotOptions,
    ) => CreateSnapshotResult;
  }
}

function createSnapshot(
  snapshotId: number,
  options?: CreateSnapshotOptions,
): CreateSnapshotResult {
  try {
    let rootElement: Element = document.body;

    if (options?.selector) {
      try {
        const selected = document.querySelector(options.selector);
        if (!selected) {
          return {
            tree: null,
            uidMap: [],
            truncated: false,
            selectorError: `Selector "${options.selector}" not found`,
          };
        }
        rootElement = selected;
      } catch {
        return {
          tree: null,
          uidMap: [],
          truncated: false,
          selectorError: `Invalid selector syntax: "${options.selector}"`,
        };
      }
    }

    const treeOptions: TreeWalkerOptions = {
      includeIframes: options?.includeIframes ?? true,
    };
    if (options?.includeAll !== undefined) {
      treeOptions.includeAll = options.includeAll;
    }

    const result = walkTree(rootElement, snapshotId, treeOptions);
    if (!result.tree) {
      return { tree: null, uidMap: [], truncated: result.truncated };
    }
    return result;
  } catch (err) {
    // Report it. Swallowing this was how a single throw deep in the walk - one Wikipedia
    // heading whose id contained a quote character - presented as "this page has no
    // interactive elements" on a page with 2,465 of them, with nothing anywhere to say
    // otherwise. An empty snapshot must be able to explain itself.
    const message = err instanceof Error ? err.message : String(err);
    return { tree: null, uidMap: [], truncated: false, snapshotError: message.slice(0, 300) };
  }
}

window.__zenExtMcpCreateSnapshot = createSnapshot;
