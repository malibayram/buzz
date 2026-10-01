# Buzz on a Mac mini behind a Cloudflare Tunnel

Runs the relay from this checkout, including the huddle video changes, on a Mac
mini. It is published as `https://buzz.magibu.ai` through a Cloudflare named
tunnel. No router ports are opened: the relay listens on `127.0.0.1:3000` only,
and `cloudflared` is the sole public ingress.

```
Desktop/mobile ──wss://buzz.magibu.ai──▶ Cloudflare edge ──tunnel──▶ cloudflared (Mac mini) ──▶ 127.0.0.1:3000 relay
                                                                                                  ├─ Postgres
                                                                                                  ├─ Redis
                                                                                                  └─ MinIO (media)
```

> **Video and Cloudflare terms.** Cloudflare's
> [video delivery policy](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/delivering-videos-with-cloudflare/)
> says streaming video through its proxy or Tunnel on Free/Pro/Business plans
> violates its terms. Chat and audio are fine. Huddle video sends video frames
> through the tunnel, so treat heavy video use as a risk. Nothing here is
> Cloudflare-specific: any HTTPS reverse proxy, or a directly exposed port,
> works with the same relay config.

## 0. Clone the code on the Mac mini

The public `ghcr.io/block/buzz:main` image does **not** contain this fork's
changes, so the Mac mini builds its own image from source:

```bash
mkdir -p ~/buzz-server && cd ~/buzz-server
git clone https://github.com/malibayram/buzz.git
cd buzz
```

If `git` isn't installed yet, macOS offers to install the command line tools the
first time you run it. Accept, then run the clone again.

## 1. Prerequisites (Mac mini)

```bash
cd ~/buzz-server/buzz
./deploy/macmini/setup.sh prereqs
```

This installs OrbStack (the Docker runtime) and `cloudflared` with Homebrew. Open
OrbStack once after it installs, then re-run the step. In **System Settings → General →
Login Items**, make sure OrbStack starts at login.

## 2. Generate the relay config

You need two things:
- **Hostname:** `buzz.magibu.ai`, set as the default in
  [`site.env`](site.env), so you can leave it out of every step. It must
  stay fixed, because the relay binds your community to it.
- **Owner key:** your identity from the desktop app. Open **Settings →
  Profile**, expand the identity details, and copy **Public key**. The copy
  button gives `npub1…`; the 64-character hex form is accepted too. This key
  becomes the relay owner.

```bash
./deploy/macmini/setup.sh env npub1yourkey…
```

To skip the argument, put your npub in `BUZZ_OWNER` in `site.env`. Public keys
aren't secret.

This writes `deploy/compose/.env` (mode 600) with fresh secrets. **Back it up**
(1Password, etc.). Losing `BUZZ_RELAY_PRIVATE_KEY` makes membership history
unverifiable. The step refuses to overwrite an existing `.env`.

## 3. Build and start the relay

```bash
./deploy/macmini/setup.sh build    # first build: ~15–30 min on an M4
./deploy/macmini/setup.sh start
```

`start` runs Postgres, Redis, MinIO, and the relay with Docker Compose. It also
applies database migrations, registers your hostname as the community, and makes
your key the owner.

## 4. Create the tunnel

```bash
./deploy/macmini/setup.sh tunnel
```

1. A browser opens. Log in to Cloudflare and pick the **magibu.ai** zone.
2. The script creates a tunnel named `buzz`, writes `~/.cloudflared/config.yml`
   pointing at `http://127.0.0.1:3000`, and adds the DNS record.
3. It installs `cloudflared` as a login service.

If the hostname already has a DNS record, delete that record in the Cloudflare
dashboard first. WebSockets are enabled by default for Cloudflare zones; keep
**Network → WebSockets** on.

Because Docker and the tunnel both start at login, turn on automatic login for the
Mac mini user (**System Settings → Users & Groups**). Also turn on **Energy → Prevent
automatic sleeping**.

## 5. Verify

```bash
./deploy/macmini/setup.sh check
```

What working looks like:
- Local `_liveness` succeeds.
- The public NIP-11 JSON includes your relay info.
- The WebSocket probe prints `101`. A `404` means the hostname isn't registered
  as a community, which happens when `RELAY_URL` doesn't match it. A `502`
  means the relay is down.

## 6. Connect the desktop app (any computer)

1. In the Buzz desktop app, open the community switcher and choose **Add
   community → Join an existing community**.
2. Enter `buzz.magibu.ai` (or `wss://buzz.magibu.ai`).
3. Use the same identity whose npub you passed in step 2. You are the owner, so
   you're admitted directly.

To invite other people:

```bash
cd ~/buzz-server/buzz/deploy/compose
./run.sh add-member npub1theirkey…
```

Mobile pairs from the desktop app (QR code). The tunnel hostname is a public
HTTPS host, so release mobile builds accept it.

## Day-2 operations

```bash
cd ~/buzz-server/buzz/deploy/compose
./run.sh logs            # follow relay logs
./run.sh status
./run.sh backup-hint     # what to back up
```

To deploy new code after pushing to GitHub:

```bash
cd ~/buzz-server/buzz
git pull
./deploy/macmini/setup.sh build && (cd deploy/compose && ./run.sh restart)
```

Your `.env` and data volumes are preserved.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Desktop says the community can't be reached | Run `check`. `cloudflared` may not be running: `launchctl list \| grep cloudflared` |
| `404` on the public hostname | `RELAY_URL` in `.env` doesn't match the hostname exactly |
| Huddle video shows "unavailable" | `BUZZ_HUDDLE_VIDEO_AVAILABLE` is not `true`, or `BUZZ_NIP_FI_MODE` was set to something other than `off` |
| Media uploads fail | `BUZZ_MEDIA_BASE_URL` must be `https://<hostname>/media` |
