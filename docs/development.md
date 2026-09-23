# Development loop

For non-prod iteration, skip AMO signing — load the extension as a temporary add-on via `web-ext run`:

```sh
npm run extension:run
```

Navigation-memory verification is local and deterministic:

```sh
npm run test:nav-memory
node scripts/probe-navmem.mjs
node scripts/smoke.mjs
```

Container routing has an offline suite and a live probe. The probe reads your real table read-only, then exercises `open_url` against a throwaway table so reuse can only land on its own tab:

```sh
npm run test:container-routes
node scripts/probe-routes.mjs
```

This opens a fresh Firefox profile with `extension/dist/` loaded as a temporary extension, no signing required. The extension is gone after the dev profile closes — fine for development.

When iterating on extension code with the signed install in production: rebuild + re-sign + remove + reinstall. Use the `npm run extension:sign` script (requires `AMO_KEY` + `AMO_SECRET`).
