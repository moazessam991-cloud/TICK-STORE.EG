# Render Limited Preview Deployment Runbook

This repository is prepared for a private, controlled preview on a Render Web Service. This document is preparation only; it does not authorize a Render deployment, an Edge Function deployment, or a database migration.

## Preview topology

`Internet -> Render HTTPS proxy -> Render Node Web Service / Express -> Supabase PostgreSQL / Storage`

Express serves the existing static SPA and `/api` routes directly; no frontend build step is required. The browser also invokes the hardened Supabase `create-order` Edge Function directly. That function is the only public order-creation path and calls service-role-only database RPCs. The retired Express `/api/public/order` endpoint returns `410`.

## Render Web Service configuration

- Runtime: Node
- Node version: `20.x`
- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/api/health`
- Auto-deploy: disabled; the owner will deliberately deploy a reviewed, clean release commit

Render must set `NODE_ENV` to `production`. The server's production startup checks intentionally fail closed if required security configuration is missing or malformed. `npm start` reads the Render environment directly and does not require a repository `.env` file. For local development, `npm run start:local` retains `.env` loading.

Render supplies `PORT` dynamically. The server parses `process.env.PORT`, rejects invalid values, and passes that port to `app.listen`. Because no restrictive hostname is supplied, Node listens on its all-interface default, which is compatible with Render's proxy. Do not configure a fixed production port.

## Proxy and client IP handling

Set `TRUST_PROXY` to `1` for the Render Web Service. The server converts that exact value to one Express trusted proxy hop before installing its rate limiters. This allows Express and `express-rate-limit` to use the client address supplied through Render's single HTTPS proxy without broadly trusting arbitrary forwarded proxy chains.

Do not expose the Node service outside Render's proxy while proxy trust is enabled, and do not increase the trusted hop count speculatively.

## Required Render environment variable names

Configure these names in the Render Web Service environment; store actual secrets only in Render's protected environment settings:

- `NODE_ENV`
- `PORT`
- `TRUST_PROXY`
- `TICK_STOREFRONT_ORIGINS`
- `TICK_DB_PATH`
- `TICK_ADMIN_PASSWORD_HASH`
- `TICK_JWT_SECRET`
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`
- `TICK_INSTAPAY_ENABLED`
- `TICK_INSTAPAY_RECIPIENT_NAME`
- `TICK_INSTAPAY_PAYMENT_URL`
- `TICK_INSTAPAY_QR_URL`
- `TICK_PUSH_ENABLED`

The browser fetches the Supabase URL and publishable key from `/api/public/runtime-config`; both are public by design. Never place the service-role key, admin password hash, JWT secret, or abuse secret in that endpoint, browser code, or public settings.

Twilio variables are optional and are not required for preview startup while WhatsApp automation is disabled.

## Storefront origin follow-up

Do not invent the service URL before Render assigns it. After Render provides the final HTTPS origin in the form `https://<render-service-name>.onrender.com`, add that exact bare origin to both environments:

1. Render Web Service: `TICK_STOREFRONT_ORIGINS`
2. Supabase `create-order` Edge Function: `TICK_STOREFRONT_ORIGINS`

The values must match exactly, with HTTPS and no path, query, or fragment. The Edge Function also retains its own existing Supabase, abuse-secret, forwarded-IP, localhost-origin, and InstaPay configuration. Updating its origin is a separate deliberate Edge Function configuration/deployment step; this runbook update does not perform it.

## Persistent disk and SQLite

Render's normal service filesystem is ephemeral. Attach a Render Persistent Disk and set `TICK_DB_PATH` to an absolute file path inside its actual mount directory. The production server rejects a missing or non-absolute path.

If, and only if, the disk is mounted at `/var/data`, a safe example is `/var/data/tick.sqlite`. If another mount path is selected in Render, use that actual path instead.

Supabase remains authoritative for products, images, episodes, settings, orders, stock, customers derived from orders, subscribers, and notification requests. SQLite retains only the optional admin drops schedule and audit log, plus obsolete seed keys with no runtime public route. Loss of the persistent disk would not lose Supabase orders or stock, but it would lose the local drops and audit history.

## Health and readiness checks

- Render health check: `GET /api/health`. This is process liveness only and performs no dependency call or database write.
- Manual post-deployment check: `GET /api/ready`. This performs a short, read-only Supabase settings query and returns `503` if the dependency is unavailable; it never writes data.

## Disabled integrations and claims

- Paymob/card: disabled; the payment-intent function returns `410`, Visa is absent from checkout, and the database rejects new non-COD/non-InstaPay orders.
- Valu/Sympl/BNPL: not implemented and not advertised.
- Standalone email relay: absent from `supabase/config.toml`; its source returns `410` and never reads a secret or sends mail.
- Automatic checkout email/WhatsApp/push: disabled. Checkout success does not wait for or depend on an external notification.
- Firebase admin push: hidden and server-disabled unless `TICK_PUSH_ENABLED` explicitly enables it; keep it disabled for this preview.
- Product video/3D upload controls: hidden for preview. Existing HTTPS media URLs can be preserved by the product API; data-URL uploads are not treated as persistence.
- CSP: Helmet's other protections are enabled, but CSP remains deferred because the monolithic SPA contains extensive inline script/style. Enabling a strict policy requires a separate frontend extraction project.

## Manual release sequence

1. Create and review a deliberate clean release commit; do not enable Render auto-deploy.
2. Confirm the approved preview migration is already applied to the intended preview Supabase project; do not reapply it, repair migration history, or reset the database.
3. Run the read-only preview security verifier and Phase 1 preflight against the intended preview catalog.
4. Confirm the hardened `create-order` Edge Function is the reviewed version and the standalone notification function is absent or disabled.
5. Create the Render Node Web Service with the runtime, build, start, health-check, and Node-version settings above.
6. Attach the persistent disk, set `TICK_DB_PATH` to its actual mount, and configure the required Render environment names.
7. After Render assigns the final HTTPS URL, configure that exact origin in both Render and the `create-order` Edge Function.
8. Deliberately deploy the reviewed release, verify `/api/health`, then manually verify `/api/ready`.
9. Execute preview-only runtime tests for origin denial, limiter windows, COD caps, stock races, privacy, and mobile checkout before considering any broader audience.
