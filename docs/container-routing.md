# Container routing: let the domain pick the container

Without a route table, a URL's container is decided by *which MCP entry issued the call* — so the same site lands in a different cookie jar depending on whether it was `zen-ext` or `zen-cxv`, and every call opens another duplicate tab. A **host → container table** makes the domain decide instead.

The table is a user config file, absent by default, read from `$XDG_CONFIG_HOME/zen-mcp/containers.json` (falling back to `~/.config/...`), or from `ZEN_MCP_ROUTES`:

```json
{
  "containers": {
    "Artist Advisory": ["artistadvisory.io"],
    "CXVentures": { "domains": ["cxventures.io"], "aliases": ["acct_1ABC99"] },
    "Buildersbuddy": ["buildersbuddy.org", "localhost:3200"],
    "Geek": { "domains": ["claude.ai", "pocketbuddy.org"], "account": "you@example.com" }
  },
  "accounts": { "pocketbuddy.org": "owner@example.org" },
  "consoles": ["search.google.com"]
}
```

`accounts` maps a host to the identity expected to be signed in there, and a container may
declare a default `account` for its hosts. The host's own entry wins, because one cookie jar
routinely holds several signed-in accounts and the host is what picks between them —
`pocketbuddy.org` and `decodo.com` both live in Geek but sign in as different people. It is
**advisory**: `open_url`, `new_page_in_container` and `container_routes` print
`expected account: ...`, nothing enforces it. A malformed account, or one naming a host
nothing routes, fails the whole file loudly rather than being dropped.

The two carriers are a top-level section and an extra key on a container object because
**every form in this file must be ignorable by an older server**. Dozens of long-lived MCP
processes read it, each loads its parser once, and a session can stay up for weeks — so a
grammar only new code can parse would disarm routing everywhere until the last one cycled,
falling back to the silent wrong jar the table exists to prevent. Unknown keys are skipped by
every past parser; a non-string inside a pattern list is not.

Each **container** declares its identifying strings: `domains` (a bare list is shorthand for domains-only) and optional `aliases` — opaque strings like a Stripe account id for consoles whose URLs carry no domain. Every domain is automatically a host rule too, so the simple case needs nothing else.

A **console** is a shared multi-project host — one login page, N projects' dashboards — like Google Search Console, where only the URL's `resource_id` says which property you're looking at. A console URL routes to whichever container's domain or alias appears in the **percent-decoded path, query, or fragment** — never the hostname or userinfo, so a container owning `stripe.com` cannot silently swallow every URL on a `dashboard.stripe.com` console — matched on token boundaries (so `pocketbuddy.org` claims neither `notpocketbuddy.org` nor `pocketbuddy.org.evil.com`). A `*.example.com` domain contributes the token `.example.com`, excluding the apex exactly as its host rule does.

Because the query is where consoles actually put the property, **the URL's own text decides the container** — appending `?x=someproject.org` steers routing. The claim catches accidents, not hostile URLs; pass `container` explicitly for a console URL you got from a page or an email. A console URL that mentions *no* configured string — the property picker, an unconfigured site — **fails loudly and opens nothing**, because falling back to the session default is precisely the wrong-cookie-jar accident the table exists to prevent. Two escape hatches: pass `container` explicitly (always wins), or add a plain `routes` rule for the console host to act as its deliberate default. **Only list a host under `consoles` if its URLs actually carry your domains or aliases** — Google Analytics, for instance, keys URLs by numeric property id, so listing it without matching aliases makes every GA URL error.

The older `{ "routes": { "Container": ["host", ...] } }` shape still works, alone or alongside the sections above.

**`projects`** picks the session default from the directory the Claude session runs in. Host rules can only route hosts that name a project; a Google Doc, a Gmail thread or a Stripe page looks the same whichever client it belongs to. So a session started in or under a listed directory defaults to that container for every URL no host rule covers:

```json
{
  "containers": { "Example Co": ["example.com"] },
  "projects": {
    "Example Co": ["~/Projects/example-co", "~/clients"],
    "Side Project": ["~/Projects/side-project"]
  }
}
```

The most specific directory wins (`~/clients/acme` can map elsewhere than `~/clients`), matching is on whole path segments, and symlinks and letter case are resolved first, so `~/projects/x` matches a rule written as `~/Projects/x`. It outranks `--container`, which becomes the fallback for sessions started anywhere else, so one user-scope registration serves every project. `~` and `/` are refused: `--container` is the catch-all layer. A directory that doesn't exist is reported by `container_routes` and never matches, rather than failing the file. A rule naming a container that doesn't exist errors and opens nothing, like a host rule would. The directory is read when the server starts and again on `container_routes({ reload: true })`.

The agent is told this at session start (the server's MCP instructions name the default and where it came from), and every call that falls back to the session default says so and suggests reopening with `container` when the task belongs to a different project. The server knows the directory; only the agent knows which client the task is for.

Matching: a rule matches its host **and its subdomains** (`cxventures.io` covers `qes.cxventures.io`); `*.example.com` matches subdomains only; `localhost:3000` pins a port. The most specific matching rule wins — console rule (host + identifying string) over any host-only rule, exact host over parent domain, port-pinned over port-agnostic.

## Precedence, tab reuse, and failure modes

Precedence, highest first: **explicit argument** (`new_page_in_container`, `open_url({ container })`) → **host rule** → **session default** (`set_default_container`, else the `projects` directory, else `--container`) → no container. A host rule outranking the session default is what makes a project's URL land in that project's jar from any `zen-*` entry. Every tab-opening call prints the decision and its source, so routing is never invisible:

```
new page tabId=1226 -> https://artistadvisory.io/artists (Artist Advisory)
container: Artist Advisory (firefox-container-8) via route "artistadvisory.io" in ~/.config/zen-mcp/containers.json
```

`open_url` is the tool that uses this end to end: it resolves the container, then **goes to the tab already open on that host in that container** — focusing it if it is already at that URL, otherwise navigating it — and opens a new tab only when there is none. Reuse looks in the active Zen workspace first and then in the other workspaces, so a logged-in tab sitting in another workspace is reused in place (and reported as `[in another Zen workspace]`) instead of a fresh tab landing on a login page. Reuse is `reuse: "host"` by default; `"exact"` reuses only a tab already at that URL, `"never"` always opens. Like `new_page`, it stays in the background unless `active: true`.

One limit worth knowing: a tab **cannot change container** — `navigate_page` therefore says so when the URL you are loading is mapped elsewhere, rather than pretending it fixed it.

Failure modes are loud on purpose: a rule naming a container that does not exist **errors and opens nothing**, because a silent fallback is how a login ends up in the wrong jar. A missing file is simply "no rules"; a malformed one reports the parse error instead of looking empty. Inspect the live state with `container_routes` (add `url` to see how one URL resolves, `reload: true` after editing the file) or the `mcp.containerRoutes` line in `get_firefox_info`. Set `ZEN_MCP_CONTAINER_ROUTES=0` to switch routing off for an entry.
