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

## Automatic deployment (GitHub Actions)

Pushing changes under `server/`, `utils/`, `Dockerfile`, `compose.yaml` or `package*.json` to
`codex/self-hosted-deployment` runs `.github/workflows/deploy-api.yml`:

1. `npm ci && npm test` on Node 22.
2. rsync of `server/`, `utils/`, `Dockerfile`, `compose.yaml`, `package*.json`, `.dockerignore` to the server.
   `.env.server` and any other server-only files are never touched.
3. `docker compose --env-file .env.server up -d --build`, then waits for `http://127.0.0.1:8787/health`.
   On failure it prints `docker compose logs` in the job output.
4. Checks the public `https://parking.kuaidianfanfan.com/health`.

The deployed commit is written to `/opt/mini-parking/DEPLOYED_REVISION`.
It can also be run manually from the Actions tab (**Deploy API → Run workflow**).

### One-time setup

On your Mac, create a key used only for deployment:

```bash
ssh-keygen -t ed25519 -N "" -C github-actions-deploy -f ~/.ssh/mini_parking_deploy
```

Copy `scripts/setup-deploy-user.sh` to the server and run it as root with the **public** key:

```bash
scp scripts/setup-deploy-user.sh root@49.64.86.64:/tmp/
ssh root@49.64.86.64 "bash /tmp/setup-deploy-user.sh \"$(cat ~/.ssh/mini_parking_deploy.pub)\""
```

This installs rsync, creates a `deploy` user in the `docker` group, hands `/opt/mini-parking` to it and
makes `.env.server` readable only by that user.

Add the repository secrets (GitHub → Settings → Secrets and variables → Actions), or with `gh`:

```bash
gh secret set DEPLOY_HOST -R dragoncheey/mini-parking -b 49.64.86.64
gh secret set DEPLOY_USER -R dragoncheey/mini-parking -b deploy
gh secret set DEPLOY_SSH_KEY -R dragoncheey/mini-parking < ~/.ssh/mini_parking_deploy
ssh-keyscan -t ed25519,rsa,ecdsa 49.64.86.64 2>/dev/null | gh secret set DEPLOY_KNOWN_HOSTS -R dragoncheey/mini-parking
```

Run `ssh-keyscan` from a network without a fake-IP proxy, or run it on the server itself against `localhost`
and replace `localhost` with `49.64.86.64`, so the fingerprint is the server's real host key.

Optional repository variables: `DEPLOY_PORT` (default `22`), `DEPLOY_PATH` (default `/opt/mini-parking`),
`HEALTHCHECK_URL` (default `https://parking.kuaidianfanfan.com/health`).

## Manual upgrade

If Actions is unavailable, sync the same files by hand and rebuild:

```bash
rsync -az --delete server/ deploy@49.64.86.64:/opt/mini-parking/server/
rsync -az --delete utils/ deploy@49.64.86.64:/opt/mini-parking/utils/
rsync -az Dockerfile compose.yaml package.json package-lock.json .dockerignore deploy@49.64.86.64:/opt/mini-parking/
ssh deploy@49.64.86.64 "cd /opt/mini-parking && docker compose --env-file .env.server up -d --build"
curl -fsS https://parking.kuaidianfanfan.com/health
```

## Rollback

Re-run the **Deploy API** workflow for the last good commit (Actions → the earlier successful run →
**Re-run all jobs**), or push a revert commit. Check `/opt/mini-parking/DEPLOYED_REVISION` to see what is live.

Database migrations are not part of this deployment, so application rollback does not require a Supabase data rollback.
