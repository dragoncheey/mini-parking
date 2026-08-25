# Self-hosted deployment runbook

## Target

- API domain: `parking.kuaidianfanfan.com`
- Server: `49.64.86.64`
- Runtime: Docker Compose with Node.js
- HTTPS/reverse proxy: an independently managed Caddy service on the server
- Database and object storage: hosted Supabase

## Before deployment

1. Rotate the root password that was shared during planning.
2. Add an SSH key and verify key-based login.
3. Restrict SSH access where practical.
4. Point DNS `A` record `parking.kuaidianfanfan.com` to `49.64.86.64`.
5. Confirm the independent Caddy service can proxy `parking.kuaidianfanfan.com` to `127.0.0.1:8787`.
6. Confirm ICP and WeChat mini-program domain requirements are satisfied for production use.

## Server files

Create `/opt/mini-parking/.env.server` from `.env.server.example` and fill real secrets on the server only.

Required production secrets:

- `SUPABASE_SERVICE_KEY`
- `WX_APP_SECRET`
- `AUTH_TOKEN_SECRET`
- `SENSENOVA_API_KEY`

Generate `AUTH_TOKEN_SECRET` with cryptographic randomness. Example:

```bash
openssl rand -base64 48
```

## Deploy

```bash
cd /opt/mini-parking
docker compose --env-file .env.server up -d --build
docker compose ps
```

The project Compose file only starts the API and binds it to `127.0.0.1:8787`. Keep TLS termination, certificates, and public ports `80`/`443` in the server's independent Caddy deployment.

## Validate Compose configuration locally

When validating with the committed example file instead of real secrets, run:

```bash
SERVER_ENV_FILE=.env.server.example docker compose --env-file .env.server.example config
```

## Verify

```bash
curl -i http://parking.kuaidianfanfan.com/health
curl -i https://parking.kuaidianfanfan.com/health
curl -i http://127.0.0.1:8787/health
docker compose logs --tail=100 api
```

Expected:

- The local API health check returns JSON with `"ok":true`.
- The independent Caddy service redirects or serves HTTP as configured.
- HTTPS returns JSON with `"ok":true`.
- `api` is healthy.
- The independent Caddy service has a valid certificate for `parking.kuaidianfanfan.com`.

## WeChat mini program settings

Add `https://parking.kuaidianfanfan.com` to:

- request legal domain
- uploadFile legal domain

Keep the Supabase project host allowed for image loading if evidence photos are rendered from Supabase public URLs.

## Supabase

Supabase remains online and hosted. Do not move PostgreSQL or Storage during this deployment.

Before first production traffic:

1. Confirm `server/migration.sql` has been applied in Supabase SQL Editor.
2. Confirm `SUPABASE_STORAGE_BUCKET` exists or let the API create it.
3. Keep the bucket public if evidence images need to render directly in the mini program.

## Upgrade

```bash
cd /opt/mini-parking
git rev-parse HEAD
git pull --ff-only
docker compose --env-file .env.server up -d --build
docker compose ps
curl -fsS https://parking.kuaidianfanfan.com/health
```

Record the previous commit before each upgrade so rollback is quick.

## Rollback

```bash
cd /opt/mini-parking
git checkout <previous-good-commit>
docker compose --env-file .env.server up -d --build
curl -fsS https://parking.kuaidianfanfan.com/health
```

Database migrations are not part of this deployment, so application rollback does not require a Supabase data rollback.
