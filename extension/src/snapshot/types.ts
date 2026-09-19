export interface UidEntry {
  uid: string;
  css: string;
  xpath?: string;
  frameId?: number;
}

export interface AriaAttributes {
  disabled?: boolean;
  hidden?: boolean;
  selected?: boolean;
  checked?: boolean | "mixed";
  pressed?: boolean | "mixed";
  expanded?: boolean;
  autocomplete?: string;
  haspopup?: boolean | string;
  invalid?: boolean | string;
  label?: string;
  labelledby?: string;
  describedby?: string;
  controls?: string;
  level?: number;
}

export interface ComputedProperties {
  focusable?: boolean;
  interactive?: boolean;
  visible?: boolean;
  accessible?: boolean;
  /**
   * Intersects the viewport right now. `visible` is style-only (display/visibility/opacity),
   * so on a long article every control in the body is `visible: true` while only a handful
   * are on screen - this is what tells those apart.
   */
  inViewport?: boolean;
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
  aria?: AriaAttributes;
  computed?: ComputedProperties;
  children: SnapshotNode[];
}

export interface CreateSnapshotOptions {
  selector?: string;
  includeAll?: boolean;
  includeIframes?: boolean;
}

export interface CreateSnapshotResult {
  tree: SnapshotNode | null;
  uidMap: UidEntry[];
  truncated: boolean;
  selectorError?: string;
  /** The walk threw and produced nothing. Without this an empty tree cannot explain itself. */
  snapshotError?: string;
}
