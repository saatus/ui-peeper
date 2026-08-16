# UI Peeper

<img width="1600" height="1000" alt="image" src="https://github.com/user-attachments/assets/55d75767-69f5-4de2-9873-c35028b2338b" />


View any webpage at several breakpoints at once, and export a full-page PNG of each.

Paste a URL. Sites that allow embedding load as live, interactive iframes at 375 / 768 / 1440.
Sites that don't — which is most of the interesting ones — fall back to server-rendered
full-page screenshots. Either way you can pull down a PNG per breakpoint, or all of them
as a zip.

Status: **working proof of concept.** Two runtime dependencies, no database, no accounts.

---

## Why it works this way

The obvious build is three `<iframe>`s side by side. That approach breaks on contact with
the real web, for reasons worth stating plainly because they shape everything else here:

- **Most sites refuse to be embedded.** `X-Frame-Options: DENY` or a CSP `frame-ancestors`
  list blocks GitHub, Google, Stripe, most banks, most SaaS marketing sites. A blocked
  iframe doesn't error — it renders a blank white box, so a naive tool silently lies.
- **A cross-origin iframe cannot be read.** No `canvas` capture (the canvas is tainted), no
  DOM access, no computed styles. So the screenshot feature and any future CSS/font/image
  extraction are impossible from the client, whatever the framing headers say.

So the server drives a real headless Chromium. `POST /api/probe` reads the framing headers
before anything renders, which is what lets a blocked site drop straight to screenshot mode
instead of showing you an empty pane and letting you wonder.

Rendering server-side also means the premium ideas (colors, font stacks, image inventory)
come nearly free later — the browser is already on the page with full DOM access.

## Quick start

Requires Node 22+.

```bash
npm install
npx playwright install chromium   # skip if a matching Chromium is already present
npm start                         # http://localhost:3000
```

If Chromium fails to launch because the installed build doesn't match the Playwright
version, point at it directly rather than downgrading:

```bash
CHROMIUM_EXECUTABLE_PATH=/path/to/chrome npm start
```

### Docker

```bash
docker build -t ui-peeper .
docker run -p 3000:3000 --init ui-peeper
```

The image pins the Playwright base tag to the `playwright` version in `package.json`;
bump both together or Chromium won't start. It runs as the unprivileged `pwuser` so
Chromium's own sandbox keeps working — see the security note below.

## Tests

```bash
npm test        # unit: URL guard, framing verdicts, zip writer
npm run test:e2e  # end-to-end: needs a running server (see below)
```

The e2e suite renders a local fixture whose media queries change colour and column count
at each breakpoint, then asserts the PNGs are the right pixel widths, are taller than one
viewport, and actually differ from each other. Three valid PNGs is not evidence a
breakpoint tool works — three *different* PNGs at the *right widths* is.

It renders from `localhost`, which the SSRF guard blocks by design, so it needs the guard
off for that run only:

```bash
UI_PEEPER_TRUST_NETWORK=1 PORT=3111 npm start   # in one shell
npm run test:e2e                                # in another
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/config` | Default breakpoints and limits |
| `POST` | `/api/probe` | `{url}` → whether the site allows embedding, and why not |
| `POST` | `/api/capture` | `{url, breakpoints}` → `202` with a job; renders in the background |
| `GET` | `/api/capture/:id` | Job status; poll until `status !== "running"` |
| `GET` | `/api/capture/:id/shot/:shotId` | The PNG (`?download=1` to force a download) |
| `GET` | `/api/capture/:id/archive.zip` | Every successful breakpoint, zipped |

Breakpoints failing individually don't fail the job — you get the ones that rendered, and
a per-pane reason for the ones that didn't.

## Security

This service fetches URLs that strangers hand it, which makes SSRF the main risk: without
a guard, `POST /api/capture {"url": "http://169.254.169.254/..."}` turns it into
screenshot-as-a-service for its own cloud metadata endpoint.

`src/lib/url-guard.js` rejects non-http(s) schemes, embedded credentials, and every private
or reserved IP range — including CGNAT, link-local, IPv4-mapped and 6to4-wrapped IPv6, and
octal-looking dotted quads. Redirects are followed by hand so every hop is re-checked, and
Chromium's own document navigations are re-validated mid-render. It's covered by tests
because the first version had a signed-int32 bug that let `169.254.169.254` straight
through — precisely the address it existed to stop.

Two honest limits:

- **DNS rebinding.** The guard resolves the hostname, then Chromium resolves it again. A
  record that changes in between would slip past. Closing that properly means pinning the
  resolved IP into the connection.
- **Sub-resources aren't checked**, only documents, to avoid a DNS lookup per image.

Both point the same way: **restrict egress at the network layer in production.** The guard
is defence in depth, not the only layer. `UI_PEEPER_TRUST_NETWORK=1` disables it entirely
and should only be set where that network-level restriction already exists.

Chromium's sandbox is deliberately left **on** — this process renders hostile HTML for a
living. That's why the container runs as a non-root user instead of passing `--no-sandbox`.

## Hosting

Headless Chromium needs roughly 1GB of RAM headroom and won't run on shared hosting or on
serverless functions (cold starts and bundle caps fight you — Vercel and Netlify functions
are not viable targets for this). Render's 512MB free tier is too small.

What works: any ordinary Linux box with ~2GB RAM. A Hetzner CX22 (~€4/mo) is the
price/performance pick; a 2GB DigitalOcean or Spaceship VPS runs ~$12/mo. Because the
service is stateless and containerised, it runs free on a laptop for as long as you like
and the hosting decision can wait until there's traffic worth paying for.

Set `TRUST_PROXY=1` behind nginx or a PaaS router so per-IP rate limiting sees real client
addresses instead of the proxy's.

## Known limitations

- **Live panes don't scroll together.** A parent page cannot read or set the scroll position
  of a cross-origin iframe — there is no workaround within the browser's security model.
  Each live pane scrolls on its own. True synced scrolling needs the page proxied through
  our own origin so a sync script can be injected; that's on the roadmap and is a
  substantially bigger, more fragile piece of work.
- Framing headers are read before render. A site that busts out of frames with JavaScript
  can still defeat the live view; the fallback is the Capture button.
- Cookie banners are captured as-is. No auto-dismissal yet.
- One user agent across all breakpoints, on purpose: a mobile UA can make a site serve
  different markup, and then panes would differ for reasons that aren't CSS.
- Pages taller than 20,000px are clipped and flagged rather than failed.
- Jobs and their PNGs are deleted 15 minutes after finishing.

## Roadmap

Free tier:
- Synced scrolling via a same-origin proxy
- Device presets, orientation toggle, custom named breakpoint sets
- Shareable capture links

Premium candidates (all of which the headless browser can already reach):
- CSS Peeper-style inspection: colour palette, font stacks, spacing scale
- Bulk image extraction with dimensions and formats
- Scheduled captures and visual diffs between runs
- PDF/contact-sheet export

## Licence

Copyright (C) 2026 Santiago Acosta.

**AGPL-3.0-only** — see [`LICENSE`](./LICENSE). This program is free software: you can
redistribute it and/or modify it under the terms of the GNU Affero General Public License,
version 3. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

Free to use, self-host and modify. The one obligation that matters: if you run a
**modified** version as a network service, you have to offer your users the source of
your version (§13). Plain GPL would not cover that, because hosting isn't distribution —
which is exactly why AGPL is the right fit for a hosted tool.

The `AGPL-3.0 · source` link in the app header is that offer. **If you deploy a fork,
repoint it at your own repository** — leaving it aimed here does not satisfy §13 for your
version.

Contributions: see [`CONTRIBUTING.md`](./CONTRIBUTING.md). Pull requests need a one-time
signature on the [CLA](./CLA.md), handled automatically by a bot on your first PR. You
keep copyright in your work; the agreement adds the right to sublicense, so the project
can be relicensed later without needing to trace every past contributor.

## Roadmap note on the premium tier

The premium ideas above are intended to live in a **separate private repository** rather
than behind a feature flag in this one. Open-core is cleaner than trying to licence-gate
features inside a single codebase, and it keeps this repo genuinely useful on its own
rather than a demo with the good parts removed.
