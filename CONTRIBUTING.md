# Contributing

Thanks for looking. Issues and pull requests are welcome.

## Licence and contributions — please read before opening a PR

UI Peeper is licensed under **AGPL-3.0-only** (see [`LICENSE`](./LICENSE)). By
contributing you agree that your contribution is licensed under those same terms.

**A contributor licence agreement is not yet in place.** Until it is, this project
cannot accept substantial code contributions, and PRs adding significant new code may
be asked to wait. That is not a judgement on the work — it is a practical constraint:

Without a CLA, the copyright in each contribution stays with its author. Relicensing
later — dual-licensing commercially, or moving a module to a different licence — would
require the individual permission of every contributor who ever landed a patch. That
gets impossible quickly, and it is the one licensing mistake that cannot be undone
after the fact.

Small fixes (typos, docs, obvious bugs) are fine to send now. If you want to build
something larger, please open an issue first so we can sort the CLA out before you
spend the time.

## What AGPL means here, in practice

- Use it, self-host it, modify it for yourself: no obligations beyond keeping the
  licence and notices intact.
- **Run a modified version as a network service**, and you must offer your users the
  source of your modified version (§13). This is the clause that distinguishes AGPL
  from GPL, and it is deliberate: hosting is not distribution, so plain GPL would not
  apply to a hosted competitor.
- The source link in the app header is that offer. If you deploy a fork, **repoint it
  at your own source** — leaving it aimed at this repository does not satisfy §13 for
  your version.

## Development

```bash
npm install
npm start          # http://localhost:3000
npm test           # unit tests
npm run test:e2e   # end-to-end; needs a server running, see README
```

Two things worth knowing before you change them:

- **`src/lib/url-guard.js` is security-critical.** It is what stops this service being
  used to screenshot cloud metadata endpoints and internal dashboards. It has tests
  because the first version had a signed-int32 bug that let `169.254.169.254` through.
  Any change here needs test coverage.
- **The Chromium sandbox stays on.** This process renders hostile HTML by design.
  Do not add `--no-sandbox`; the container runs as a non-root user so the sandbox keeps
  working.

Please run `npm test` before opening a PR.
