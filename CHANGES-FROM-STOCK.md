# Changes From Stock

Tracks every deviation from the upstream template (`https://github.com/lukesbrave/digital-home-backend`)
so upstream updates can be pulled in cleanly later. No branding, styling, or
content-corpus changes belong in this repo.

## wrangler.jsonc

- `vars.SUPABASE_URL`, `vars.SUPABASE_ANON_KEY`, `vars.NEXT_PUBLIC_SUPABASE_URL`,
  `vars.NEXT_PUBLIC_SUPABASE_ANON_KEY` replaced with this project's real
  Supabase project URL / publishable key.
- `vars.DIGITAL_HOME_URL` and `vars.NEXT_PUBLIC_DIGITAL_HOME_URL` replaced
  with this project's live Frontend Worker URL
  (`https://digital-home-frontend.chad-1a0.workers.dev`).
- `vars.R2_PUBLIC_BASE` left as the stock placeholder — Meta/social setup is
  deferred, not part of the golden-path plumbing check.

All project-specific — every clone must set its own.

## .env.local (gitignored, not committed)

- Created from `.env.local.example`. Filled with this project's Supabase
  URL/anon/service_role keys, the same generated `API_SECRET_KEY` as the
  Frontend, `DIGITAL_HOME_URL` pointing at the live Frontend Worker,
  `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.

## Cloudflare R2 bucket

- Created a `social-media` R2 bucket in Cloudflare (referenced by
  `wrangler.jsonc`'s `r2_buckets` binding but did not exist yet — deploy
  fails without it, independent of whether social/Meta features are used).

## Cloudflare Worker secrets (not in repo)

Set via `wrangler secret put`: `SUPABASE_SERVICE_ROLE_KEY`, `API_SECRET_KEY`,
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.

**Known template gap:** the runbook's secret list also named `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, and `DIGITAL_HOME_URL` as secrets, but Cloudflare
rejects setting a secret with the same binding name as an existing `var` —
these three are correctly `vars`-only (matches this repo's own CLAUDE.md).
Skipped setting them as secrets; no functional gap since the vars carry the
same values.

**Known gap:** `RESEND_API_KEY` is not in this repo's `.env.local.example`
or documented secret list, but `src/lib/crm/email.ts` (`sendCrmEmail`,
`notifyOwner`) reads `process.env.RESEND_API_KEY` to send real CRM emails.
Without it, CRM email always runs in safe/simulated mode regardless of the
`safe_mode` setting. Left unset for now — real CRM email send is deferred,
not part of the golden-path plumbing check.

## Supabase data (not in repo)

- Public `images` storage bucket created (article hero images).
- Admin user created via `scripts/create-user.ts`
  (`admin@yourdomain.com` — placeholder identity, auto-confirmed, no real
  inbox needed).
- Seeded two `brand_context` rows via `POST /api/setup`: `cta/links` and
  `identity/author`, both generic placeholder content (no branding).

## No other changes

No components, pages, or CRM logic have been modified.
