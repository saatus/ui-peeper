# Contributing

Thanks for looking. Issues and pull requests are welcome.

## Licence and the CLA — please read before opening a PR

UI Peeper is licensed under **AGPL-3.0-only** (see [`LICENSE`](./LICENSE)).

Pull requests require a one-time signature on the
[Contributor License Agreement](./CLA.md). Open your PR as normal — a bot will comment
with the link and the exact phrase to reply with. Signing takes about ten seconds and
you only ever do it once; later PRs are checked against the recorded signature.

**You keep the copyright in your work.** The CLA is a licence, not a transfer. What it
adds is the right to sublicense, which is what lets the project be relicensed later —
offering a commercial licence alongside AGPL, say — without tracking down every past
contributor for individual written permission. Without that, a single unreachable
contributor can freeze the licence permanently. It is the one licensing decision that
genuinely cannot be fixed after the fact, which is why the bot is in place before the
first outside PR rather than after.

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
