import { randomUUID } from "node:crypto";
import {
  Methods,
  NAV_NOTE_CAPS,
  NAV_NOTE_KINDS,
  type NavEventRecord,
  type NavMemoryEtlNowResult,
  type NavMemoryForgetParams,
  type NavMemoryQueryParams,
  type NavMemoryQueryResult,
  type NavMemoryRecordEventsParams,
  type NavMemoryRecordEventsResult,
  type NavMemoryStatsResult,
  type NavNote,
  type NavNoteSummary,
  type NavSessionLog,
} from "@zen-mcp/shared";
import {
  containsPromptLikeText,
  isDevHost,
  normalizeHost,
  normalizeSummary,
  normalizeUrl,
  redactText,
  registrableDomain,
  sanitizeLocator,
  truncateUtf8,
  validPathGlob,
} from "@zen-mcp/shared/nav-redact";
import { log } from "../log.js";
import { type DistilledNote, type Distiller, MAX_KNOWN_NOTES } from "./distill.js";
import { encodeEmbedding, type Embedder, MERGE_SIMILARITY, nearestNote, dot, decodeEmbedding } from "./embeddings.js";
import { rankNotes, scoreNote } from "./ranking.js";
import { applySeeds, noteId } from "./seeds.js";
import { type EtlMutation, JsonNavStore } from "./store.js";

const MAX_SESSION_EVENTS = 500;
// Checkpoint before the cap so a long session flushes whole batches instead of
// shift-dropping its oldest events; re-learned facts merge rather than duplicate.
const SESSION_HIGH_WATER = 400;
// A session that has gone quiet this long is flushed to disk, so an abrupt
// daemon death (SIGKILL) can lose at most this much telemetry.
const IDLE_CHECKPOINT_MS = 10 * 60 * 1_000;
const CONSOLIDATE_INTERVAL_MS = 60 * 60 * 1_000;
// Pairwise sweep is O(n^2) per host; the cap keeps a pathological store bounded.
const MAX_CONSOLIDATE_COMPARISONS = 20_000;
const ALLOWED_TOOLS = new Set([
  "navigate_page", "new_page", "new_page_in_container", "select_page", "navigate_history",
  "take_snapshot", "clear_snapshot", "click_by_uid", "hover_by_uid", "fill_by_uid",
  "fill_form_by_uid", "drag_by_uid_to_uid", "resolve_uid_to_selector", "evaluate_script",
  "screenshot_page", "get_page_text", "read_page", "find_by_text", "wait_for", "click",
  // fill_secret events are structural like fill's: tool, host, path, ok, locator — never a value.
  "hover", "fill", "fill_secret", "type", "drag", "select_option", "press_key", "scroll", "get_cookies",
  "set_cookies", "clear_cookies", "get_storage", "set_storage", "clear_storage",
]);

interface SessionState {
  container: string | null;
  startedAt: string;
  lastEventAt: number;
  events: NavEventRecord[];
}

export class NavServiceError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
  }
}

export interface NavServiceContext {
  connId: string;
  containerScope: string | null;
}

export class NavMemoryService {
  private sessions = new Map<string, SessionState>();
  private workChain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private tickRunning = false;
  private finalizations = new Set<Promise<void>>();
  private droppedEvents = 0;

  constructor(
    readonly store: JsonNavStore,
    private readonly distiller: Distiller,
    private readonly embedder: Embedder,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async init(): Promise<void> {
    await this.store.init();
    const meta = this.store.getMeta();
    if (meta.embeddingModel !== this.embedder.model || meta.embeddingDimension !== this.embedder.dimension) {
      const notes = this.store.allNotes().map((note) => ({ ...note, embedding: null }));
      await this.store.replaceAllNotes(notes, {
        embeddingModel: this.embedder.model,
        embeddingDimension: this.embedder.dimension,
      });
    }
    await applySeeds(this.store, this.now());
    await this.store.prune(this.now().getTime());
  }

  async handleRequest(ctx: NavServiceContext, method: string, raw: unknown): Promise<unknown> {
    switch (method) {
      case Methods.NavMemoryQuery:
        return this.query(raw);
      case Methods.NavMemoryRecordEvents:
        return this.recordEvents(ctx, raw);
      case Methods.NavMemoryStats:
        return this.stats();
      case Methods.NavMemoryForget:
        return this.forget(raw);
      case Methods.NavMemoryEtlNow:
        if (process.env.ZEN_MCP_NAV_ETL_PROBE !== "1") throw new NavServiceError(-32601, "method not found");
        return this.serializedWork(() => this.processOne());
      default:
        throw new NavServiceError(-32601, `unknown nav-memory method: ${method}`);
    }
  }

  private parseQuery(raw: unknown): Required<Pick<NavMemoryQueryParams, "host" | "limit" | "full">> & NavMemoryQueryParams {
    if (!raw || typeof raw !== "object") throw new NavServiceError(-32602, "query params must be an object");
    const p = raw as NavMemoryQueryParams;
    const host = normalizeHost(p.host);
    if (!host) throw new NavServiceError(-32602, "invalid host");
    const full = p.full === true;
    const maximum = full ? 50 : 8;
    const limit = Math.min(maximum, Math.max(1, Number.isInteger(p.limit) ? p.limit! : maximum));
    const path = typeof p.path === "string" && p.path.startsWith("/") ? p.path.slice(0, 500) : undefined;
    const queryText = typeof p.queryText === "string" ? truncateUtf8(redactText(p.queryText), 300) : undefined;
    return { host, limit, full, ...(path ? { path } : {}), ...(queryText ? { queryText } : {}) };
  }

  private async query(raw: unknown): Promise<NavMemoryQueryResult> {
    const p = this.parseQuery(raw);
    const domain = registrableDomain(p.host);
    const allRanked = rankNotes(this.store.allNotes(), {
      host: p.host,
      registrableDomain: domain,
      ...(p.path ? { path: p.path } : {}),
      includeOutOfScope: p.full,
    }, 50);
    let ranked = allRanked;
    if (p.full && p.queryText && (await this.embedder.isAvailable())) {
      try {
        const query = await this.embedder.embedQuery(p.queryText);
        const maxRank = Math.max(1e-9, ...allRanked.map((note) => scoreNote(note, { host: p.host, registrableDomain: domain, ...(p.path ? { path: p.path } : {}) })));
        ranked = [...allRanked].sort((a, b) => hybridScore(b, query, maxRank, p, this.embedder.dimension) - hybridScore(a, query, maxRank, p, this.embedder.dimension));
      } catch {
        // Deterministic rank is the availability fallback.
      }
    }
    const notes = ranked.slice(0, p.limit).map((note) => p.full ? note : ({
      id: note.id,
      host: note.host,
      pathGlob: note.pathGlob,
      kind: note.kind,
      summary: note.summary,
      confidence: note.confidence,
      reinforced: note.reinforced,
    }));
    return { host: p.host, registrableDomain: domain, total: allRanked.length, notes };
  }

  private async recordEvents(ctx: NavServiceContext, raw: unknown): Promise<NavMemoryRecordEventsResult> {
    const params = raw as Partial<NavMemoryRecordEventsParams> | null;
    if (!params || !Array.isArray(params.events)) throw new NavServiceError(-32602, "events must be an array");
    const state = this.sessions.get(ctx.connId) ?? {
      container: ctx.containerScope,
      startedAt: this.now().toISOString(),
      lastEventAt: this.now().getTime(),
      events: [],
    };
    let accepted = 0;
    let dropped = 0;
    for (const rawEvent of params.events.slice(0, 50)) {
      const event = validateEvent(rawEvent, this.now().getTime());
      if (!event) {
        dropped += 1;
        continue;
      }
      if (state.events.length >= MAX_SESSION_EVENTS) {
        state.events.shift();
        dropped += 1;
      }
      state.events.push(event);
      accepted += 1;
    }
    dropped += Math.max(0, params.events.length - 50);
    this.droppedEvents += dropped;
    state.lastEventAt = this.now().getTime();
    this.sessions.set(ctx.connId, state);
    if (state.events.length >= SESSION_HIGH_WATER) await this.onSessionEnd(ctx.connId);
    return { accepted, dropped };
  }

  async onSessionEnd(connId: string): Promise<void> {
    const work = this.finalizeSession(connId);
    this.finalizations.add(work);
    try {
      await work;
    } finally {
      this.finalizations.delete(work);
    }
  }

  private async finalizeSession(connId: string): Promise<void> {
    const state = this.sessions.get(connId);
    this.sessions.delete(connId);
    if (!state || state.events.length === 0) return;
    const endedAt = this.now().toISOString();
    const byHost = new Map<string, NavEventRecord[]>();
    for (const event of state.events) {
      if (!event.host) continue;
      const events = byHost.get(event.host) ?? [];
      events.push(event);
      byHost.set(event.host, events);
    }
    const logs: NavSessionLog[] = [...byHost.entries()].map(([host, events]) => ({
      schemaVersion: 1,
      workId: randomUUID(),
      host,
      registrableDomain: registrableDomain(host),
      container: state.container,
      startedAt: state.startedAt,
      endedAt,
      attempts: 0,
      events: events.slice(0, MAX_SESSION_EVENTS),
    }));
    if (logs.length > 0) await this.store.saveSessionLogs(logs);
  }

  async tick(): Promise<void> {
    if (this.stopped || this.tickRunning) return;
    this.tickRunning = true;
    try {
      await this.serializedWork(async () => {
        await this.checkpointIdleSessions();
        await this.store.prune(this.now().getTime());
        await this.processOne();
        await this.backfillEmbeddings();
        await this.decay();
        await this.consolidate();
        if (this.droppedEvents > 0) {
          const meta = this.store.getMeta();
          await this.store.setMeta({ droppedEvents: meta.droppedEvents + this.droppedEvents });
          this.droppedEvents = 0;
        }
      });
    } finally {
      this.tickRunning = false;
    }
  }

  // The connection stays open; the next event simply starts a fresh session.
  private async checkpointIdleSessions(): Promise<void> {
    const now = this.now().getTime();
    for (const [connId, state] of [...this.sessions]) {
      if (state.events.length === 0 || now - state.lastEventAt <= IDLE_CHECKPOINT_MS) continue;
      await this.onSessionEnd(connId);
    }
  }

  private serializedWork<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.workChain.catch(() => undefined).then(fn);
    this.workChain = next;
    return next;
  }

  private async processOne(): Promise<NavMemoryEtlNowResult> {
    const claimed = await this.store.claimOldest();
    if (!claimed) return { status: "empty" };
    const { filename, log: session } = claimed;
    if (this.store.getMeta().processedWorkIds.includes(session.workId)) {
      await this.store.completeWork(filename);
      return { status: "processed", workId: session.workId, notes: 0 };
    }
    try {
      const existing = this.store.allNotes();
      // The distiller is the only component that can reliably say "same fact",
      // so it gets the host's current notes and answers with `reinforces`.
      const known = rankNotes(
        existing.filter((note) => note.host === session.host),
        { host: session.host, registrableDomain: session.registrableDomain, includeOutOfScope: true },
        MAX_KNOWN_NOTES,
      );
      const distilled = await this.distiller.distill(session, known.map(toSummary));
      const candidates = distilled
        .map((item) => ({ item, note: toNote(item, session, this.now()) }))
        .filter((entry): entry is { item: DistilledNote; note: NavNote } => Boolean(entry.note));
      const mutations: EtlMutation[] = [];
      const ollama = candidates.length > 0 && await this.embedder.isAvailable();
      for (const { item, note } of candidates) {
        const reinforced = resolveReinforces(item.reinforces, known);
        if (reinforced) {
          mutations.push({ note, mergeIntoId: reinforced.id });
          continue;
        }
        const exact = existing.find((entry) => entry.id === note.id);
        if (exact) {
          mutations.push({ note, mergeIntoId: exact.id });
          continue;
        }
        if (ollama) {
          try {
            const [vector] = await this.embedder.embedDocuments([`${note.summary}\n${note.detail}`]);
            if (vector) {
              note.embedding = encodeEmbedding(vector);
              const nearest = nearestNote(existing.filter((entry) => entry.host === note.host), vector, this.embedder.dimension);
              mutations.push(nearest && nearest.score >= MERGE_SIMILARITY ? { note, mergeIntoId: nearest.note.id } : { note });
              continue;
            }
          } catch {
            // Text equality below is the embedding outage fallback.
          }
        }
        const normalized = normalizeSummary(note.summary);
        const same = existing.find((entry) => entry.host === note.host && normalizeSummary(entry.summary) === normalized);
        mutations.push(same ? { note, mergeIntoId: same.id } : { note });
      }
      const { changed, created, merged } = await this.store.applyEtlBatch(session.workId, mutations, this.now());
      await this.store.completeWork(filename);
      log.info("nav-memory ETL processed", { host: session.host, workId: session.workId, created, merged });
      return { status: "processed", workId: session.workId, notes: changed };
    } catch (err) {
      await this.store.retryWork(filename, session);
      log.warn("nav-memory ETL failed", { workId: session.workId, attempts: session.attempts, err: (err as Error).message });
      return { status: "failed", workId: session.workId };
    }
  }

  private async backfillEmbeddings(): Promise<void> {
    if (!(await this.embedder.isAvailable())) return;
    const notes = this.store.allNotes().filter((note) => !note.embedding).slice(0, 32);
    if (notes.length === 0) return;
    try {
      const vectors = await this.embedder.embedDocuments(notes.map((note) => `${note.summary}\n${note.detail}`));
      await this.store.updateNotes(notes.map((note, index) => ({ ...note, embedding: vectors[index] ? encodeEmbedding(vectors[index]!) : null })));
    } catch {
      // Backfill is best-effort and retried on a later tick.
    }
  }

  private async decay(): Promise<void> {
    const meta = this.store.getMeta();
    const now = this.now().getTime();
    if (!meta.lastDecayAt) {
      await this.store.setMeta({ lastDecayAt: new Date(now).toISOString() });
      return;
    }
    const previous = Date.parse(meta.lastDecayAt);
    if (now - previous < 86_400_000) return;
    const elapsedDays = Math.max(0, (now - previous) / 86_400_000);
    const notes: NavNote[] = [];
    for (const note of this.store.allNotes()) {
      const ageDays = Math.max(0, (now - Date.parse(note.lastSeenAt)) / 86_400_000);
      let confidence = note.confidence;
      if (ageDays > 60) confidence *= 0.98 ** (elapsedDays / 7);
      if (note.source?.seed) confidence = Math.max(0.5, confidence);
      if (!note.source?.seed && confidence < 0.2 && note.reinforced === 1 && ageDays > 180) continue;
      notes.push({ ...note, confidence });
    }
    await this.store.replaceAllNotes(notes, { lastDecayAt: new Date(now).toISOString() });
  }

  // Safety net for the reinforces path: the distiller only sees one host's
  // notes for one session, so near-duplicates that arrived by other routes are
  // folded together here. Removing either half stops merges from happening.
  private async consolidate(): Promise<void> {
    const meta = this.store.getMeta();
    const now = this.now().getTime();
    const previous = meta.lastConsolidateAt ? Date.parse(meta.lastConsolidateAt) : Number.NaN;
    if (Number.isFinite(previous) && now - previous < CONSOLIDATE_INTERVAL_MS) return;
    const stamp = new Date(now).toISOString();

    const byHost = new Map<string, Array<{ note: NavNote; vector: Float32Array }>>();
    for (const note of this.store.allNotes()) {
      if (!note.embedding) continue;
      const vector = decodeEmbedding(note.embedding, this.embedder.dimension);
      if (!vector) continue;
      const group = byHost.get(note.host) ?? [];
      group.push({ note, vector });
      byHost.set(note.host, group);
    }

    const surviving = new Map(this.store.allNotes().map((note) => [note.id, note]));
    const dropped = new Set<string>();
    let comparisons = 0;
    let capped = false;
    let merges = 0;
    for (const [host, group] of byHost) {
      for (let i = 0; i < group.length && !capped; i++) {
        for (let j = i + 1; j < group.length; j++) {
          if (comparisons++ >= MAX_CONSOLIDATE_COMPARISONS) {
            capped = true;
            break;
          }
          const left = group[i]!;
          const right = group[j]!;
          if (dropped.has(left.note.id) || dropped.has(right.note.id)) continue;
          // Two seeds are never collapsed: a seed may be a merge target, never
          // a deleted source.
          if (left.note.source?.seed && right.note.source?.seed) continue;
          const score = dot(left.vector, right.vector);
          if (score < MERGE_SIMILARITY) continue;
          const [target, source] = mergeOrder(left.note, right.note);
          const combined = mergeNotes(target, source);
          surviving.set(target.id, combined);
          surviving.delete(source.id);
          dropped.add(source.id);
          if (left.note.id === target.id) left.note = combined;
          else right.note = combined;
          merges += 1;
          log.info("nav-memory consolidated notes", {
            host,
            kept: target.id,
            dropped: source.id,
            score: Number(score.toFixed(4)),
            reinforced: combined.reinforced,
          });
        }
      }
      if (capped) break;
    }
    if (capped) log.warn("nav-memory consolidation hit its comparison cap", { comparisons, merges });

    if (merges === 0) {
      await this.store.setMeta({ lastConsolidateAt: stamp });
      return;
    }
    await this.store.replaceAllNotes([...surviving.values()], {
      lastConsolidateAt: stamp,
      consolidated: meta.consolidated + merges,
    });
  }

  private async stats(): Promise<NavMemoryStatsResult> {
    const notes = this.store.allNotes();
    const counts = await this.store.counts();
    const meta = this.store.getMeta();
    const byHost: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    for (const note of notes) {
      byHost[note.host] = (byHost[note.host] ?? 0) + 1;
      byKind[note.kind] = (byKind[note.kind] ?? 0) + 1;
    }
    const present = notes.filter((note) => Boolean(note.embedding)).length;
    return {
      notes: notes.length,
      byHost,
      byKind,
      ...counts,
      storeBytes: await this.store.storeBytes(),
      embeddings: { present, missing: notes.length - present, model: meta.embeddingModel, dimension: meta.embeddingDimension },
      etl: {
        created: meta.etlCreated,
        merged: meta.etlMerged,
        consolidated: meta.consolidated,
        lastEtlAt: meta.lastEtlAt,
        lastConsolidateAt: meta.lastConsolidateAt,
      },
      suppressedSeeds: meta.suppressedSeedIds.length,
      pruned: meta.pruned,
      droppedEvents: meta.droppedEvents + this.droppedEvents,
      ollama: this.embedder.status(),
    };
  }

  private async forget(raw: unknown): Promise<unknown> {
    if (!raw || typeof raw !== "object") throw new NavServiceError(-32602, "forget params must be an object");
    const p = raw as NavMemoryForgetParams;
    const hasId = typeof p.id === "string" && p.id.length > 0;
    const host = typeof p.host === "string" ? normalizeHost(p.host) : null;
    if (hasId === Boolean(host)) throw new NavServiceError(-32602, "provide exactly one of id or host");
    return this.store.forget({ ...(hasId ? { id: p.id } : { host: host! }), includeRaw: p.includeRaw !== false });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.workChain.catch(() => undefined);
    await Promise.all([...this.sessions.keys()].map((id) => this.onSessionEnd(id)));
    await Promise.all([...this.finalizations]);
    await this.store.close();
  }
}

function validateEvent(raw: unknown, now: number): NavEventRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<NavEventRecord>;
  if (typeof p.tool !== "string" || !ALLOWED_TOOLS.has(p.tool) || typeof p.ok !== "boolean") return null;
  let host: string | undefined;
  let path: string | undefined;
  if (typeof p.host === "string") {
    const normalized = normalizeUrl(`https://${p.host}${typeof p.path === "string" ? p.path : "/"}`);
    // Dev-host events are also refused server-side in deriveLocation; this
    // guard covers older server processes that predate that check.
    if (normalized && !isDevHost(normalized.host)) ({ host, path } = normalized);
  }
  const ts = typeof p.ts === "number" && Math.abs(p.ts - now) <= 86_400_000 ? p.ts : now;
  const event: NavEventRecord = { ts, tool: p.tool, ok: p.ok };
  if (host) event.host = host;
  if (path) event.path = path;
  if (p.navigated === true) event.navigated = true;
  if (typeof p.errorCode === "string" && /^[A-Z_]{2,32}$/.test(p.errorCode)) event.errorCode = p.errorCode;
  for (const key of ["locator", "relatedLocator"] as const) {
    if (typeof p[key] === "string") {
      const clean = sanitizeLocator(p[key]!);
      if (clean) event[key] = clean;
    }
  }
  if (typeof p.keys === "string" && /^[A-Za-z0-9+ ]{1,40}$/.test(p.keys)) event.keys = p.keys;
  if (typeof p.waitCondition === "string" && /^[a-z_]{1,32}$/.test(p.waitCondition)) event.waitCondition = p.waitCondition;
  if (Number.isInteger(p.matchCount) && p.matchCount! >= 0 && p.matchCount! <= 10_000) event.matchCount = p.matchCount;
  if (typeof p.role === "string" && /^[a-z-]{1,40}$/.test(p.role)) event.role = p.role;
  if (Number.isInteger(p.snapshotUids) && p.snapshotUids! >= 0 && p.snapshotUids! <= 100_000) event.snapshotUids = p.snapshotUids;
  if (typeof p.snapshotTruncated === "boolean") event.snapshotTruncated = p.snapshotTruncated;
  return event.host ? event : null;
}

function toSummary(note: NavNote): NavNoteSummary {
  return {
    id: note.id,
    host: note.host,
    pathGlob: note.pathGlob,
    kind: note.kind,
    summary: note.summary,
    confidence: note.confidence,
    reinforced: note.reinforced,
  };
}

// Only an in-range 1-based index into the list the distiller was shown counts;
// anything else falls through to the normal new-note paths.
function resolveReinforces(value: unknown, known: NavNote[]): NavNote | null {
  if (!Number.isInteger(value)) return null;
  const index = value as number;
  if (index < 1 || index > known.length) return null;
  return known[index - 1] ?? null;
}

function mergeOrder(left: NavNote, right: NavNote): [NavNote, NavNote] {
  if (left.source?.seed !== right.source?.seed) return left.source?.seed ? [left, right] : [right, left];
  if (left.confidence !== right.confidence) return left.confidence > right.confidence ? [left, right] : [right, left];
  const created = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (created !== 0) return created < 0 ? [left, right] : [right, left];
  return left.id.localeCompare(right.id) <= 0 ? [left, right] : [right, left];
}

function mergeNotes(target: NavNote, source: NavNote): NavNote {
  const preferSource = source.confidence > target.confidence;
  return {
    ...target,
    detail: preferSource ? source.detail : target.detail,
    example: preferSource ? source.example : target.example,
    tools: [...new Set([...target.tools, ...source.tools])].slice(0, 12),
    success: target.success || source.success,
    confidence: Math.max(target.confidence, source.confidence),
    reinforced: target.reinforced + source.reinforced,
    createdAt: Date.parse(source.createdAt) < Date.parse(target.createdAt) ? source.createdAt : target.createdAt,
    lastSeenAt: Date.parse(source.lastSeenAt) > Date.parse(target.lastSeenAt) ? source.lastSeenAt : target.lastSeenAt,
  };
}

function toNote(item: DistilledNote, session: NavSessionLog, now: Date): NavNote | null {
  if (!NAV_NOTE_KINDS.includes(item.kind) || typeof item.summary !== "string" || typeof item.detail !== "string") return null;
  const summary = truncateUtf8(redactText(item.summary).replace(/\s+/g, " ").trim(), NAV_NOTE_CAPS.summary);
  const detail = truncateUtf8(redactText(item.detail).replace(/\s+/g, " ").trim(), NAV_NOTE_CAPS.detail);
  if (!summary || !detail || containsPromptLikeText(summary) || containsPromptLikeText(detail)) return null;
  const example = typeof item.example === "string" ? truncateUtf8(redactText(item.example).replace(/\s+/g, " ").trim(), NAV_NOTE_CAPS.example) : null;
  if (example && containsPromptLikeText(example)) return null;
  if (typeof item.pathGlob === "string" && !validPathGlob(item.pathGlob)) return null;
  const pathGlob = typeof item.pathGlob === "string" ? item.pathGlob : null;
  if (!Array.isArray(item.tools) || item.tools.some((tool) => typeof tool !== "string" || !ALLOWED_TOOLS.has(tool))) return null;
  const tools = [...new Set(item.tools)].slice(0, 12);
  const confidence = Math.min(0.7, Math.max(0, Number.isFinite(item.confidence) ? item.confidence : 0));
  const timestamp = now.toISOString();
  return {
    id: noteId(session.host, item.kind, summary),
    host: session.host,
    registrableDomain: session.registrableDomain,
    pathGlob,
    kind: item.kind,
    summary,
    detail,
    example: example || null,
    tools,
    success: item.success === true,
    confidence,
    reinforced: 1,
    createdAt: timestamp,
    lastSeenAt: timestamp,
    source: { container: session.container ?? undefined, sessionTs: session.endedAt, workId: session.workId },
    embedding: null,
  };
}

function hybridScore(note: NavNote, query: Float32Array, maxRank: number, p: NavMemoryQueryParams & { host: string }, dimension: number): number {
  const vector = note.embedding ? decodeEmbedding(note.embedding, dimension) : null;
  const semantic = vector ? Math.max(0, Math.min(1, (dot(vector, query) + 1) / 2)) : 0;
  const rank = scoreNote(note, { host: p.host, registrableDomain: registrableDomain(p.host), ...(p.path ? { path: p.path } : {}) }) / maxRank;
  return semantic * 0.6 + rank * 0.4;
}
