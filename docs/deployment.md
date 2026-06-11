# Deployment

Target: one small VPS. The app is a single Node.js process; SQLite and media live on local disk.

## Required environment

Generate strong values once and never rotate `APP_ENCRYPTION_KEY` casually (it encrypts stored X tokens and salts visitor hashes):

```bash
openssl rand -hex 32   # APP_ENCRYPTION_KEY
openssl rand -hex 32   # SESSION_SECRET
```

Set `SITE_URL` to the public origin (used in emails, RSS, sitemap, canonical URLs).

## Docker

```bash
docker compose up -d --build
```

`docker-compose.yml` mounts `./data` (database + media) and `./backups`. Upgrades: pull, rebuild, restart — migrations run automatically on boot.

## systemd (alternative)

```ini
[Unit]
Description=EchoPost
After=network.target

[Service]
WorkingDirectory=/opt/echopost
ExecStart=/usr/bin/node --import tsx src/server.ts
EnvironmentFile=/opt/echopost/.env
Restart=always
User=echopost

[Install]
WantedBy=multi-user.target
```

## Reverse proxy (Caddy)

```caddy
example.com {
    encode gzip
    reverse_proxy 127.0.0.1:3000
}
```

Caddy provides HTTPS automatically. The app sets `trustProxy`, so client IPs (for the privacy hash) come from `X-Forwarded-For`.

## Operations

- Health: `GET /health`, `/health/db`, `/health/jobs` (503 when the queue backs up or dead jobs accumulate).
- Logs: pino JSON on stdout — `journalctl -u echopost` or `docker logs`.
- Disk: media grows in `data/media`; backups in `backups/`. Alert at 80% disk usage.
- The job worker runs inside the web process: run exactly **one** instance.
