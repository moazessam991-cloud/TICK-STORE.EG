# TICK store (full-stack)

Node.js API + SQLite + single-page storefront (`public/index.html`).

## Run locally

```bash
npm install
npm start
```

Open [http://127.0.0.1:38471](http://127.0.0.1:38471) — health check: [http://127.0.0.1:38471/api/health](http://127.0.0.1:38471/api/health).

## Environment

Copy `config.sample.env` to `.env` on your host (or set variables in Railway/Render). At minimum for production:

- `TICK_JWT_SECRET` — long random string  
- `TICK_ADMIN_PASSWORD` — admin login password (same rules as the site)  
- `TICK_DB_PATH` — path to SQLite file on a **persistent disk** (e.g. `/data/tick.sqlite`)

Optional: Twilio WhatsApp — see `config.sample.env`.

## Push to GitHub

From your Mac (normal Terminal — not a restricted sandbox):

```bash
cd /Users/air/tick-store
bash scripts/push-to-github.sh
gh repo create tick-store --public --source=. --remote=origin --push
```

Install [GitHub CLI](https://cli.github.com/) (`brew install gh`) and run `gh auth login` once if needed.  
Or create an empty repo on github.com and use `git remote add origin …` then `git push -u origin main`.

## Host on Railway / Render

1. Push this repo to GitHub.  
2. New service from repo; start command: `npm start`.  
3. Add a **volume** (or disk) and set `TICK_DB_PATH` to a file inside that mount.  
4. Set `PORT` from the platform if required (often injected automatically).

The app serves `public/index.html` at `/` unless `TICK_HTML` overrides it.

## Tests

```bash
npm run test:all
```
# TICK-STORE.EG
