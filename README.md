# MyShopSwift

A West African grocery + gadgets storefront for the UK market: customer
accounts, checkout with Cash on Delivery or card payment, order
management, and a live admin panel for products, categories, orders,
and customers.

## What's in here

```
myshopswift/
├── server.js            — the backend (Express)
├── rewards.js            — rewards/loyalty logic (see below)
├── flyers.js              — brand flyers upload + storage logic (see below)
├── package.json
├── .env.example           — copy to .env and fill in your own values
└── migrate-*.js            — one-time scripts that copied each table's
                              data from data/*.json into Postgres; not run
                              by the app itself, kept for reference

public/
├── index.html            — the storefront customers see
└── admin.html             — the admin panel
```

**Data storage:** users, sessions, orders, products/categories, password
resets, admin notifications, and all rewards/loyalty data live in
PostgreSQL (Neon) — see `DATABASE_URL` in `.env.example`. Only the contact
form and brand flyers are still plain JSON files under `data/`.

## Running it locally

Requires [Node.js](https://nodejs.org) 18+.

```bash
cd myshopswift
npm install
cp .env.example .env
```

Edit `.env`:
- `ADMIN_KEY` — a password only you know; the admin panel needs this
  to publish catalogue changes or manage orders.
- `STRIPE_SECRET_KEY` — optional. Leave blank and card payment is
  disabled but Cash on Delivery still works fully. Add a real Stripe
  secret key to enable "Pay by card" at checkout (Stripe Checkout
  handles the card form — no card details ever touch this server).
- `PUBLIC_URL` — set this to your real deployed URL once live, so
  Stripe's redirect back to your site works correctly.

Then:

```bash
npm start
```

- Storefront: http://localhost:3000
- Admin panel: http://localhost:3000/admin.html

## What customers can do

- Create an account / sign in (email + password, sessions via a
  secure httpOnly cookie — nothing stored in browser localStorage)
- Browse, search, and filter the catalogue
- Add to basket, check out with a delivery address
- Choose Cash on Delivery, or pay by card via Stripe if configured
- View their own past orders from the account panel

## What the admin panel does

Enter your `ADMIN_KEY` in the header field, then:
- **Products / Categories** — add, edit, delete; **Publish live**
  pushes changes to the storefront immediately
- **Orders** — view every order with customer, items, total, delivery
  address, and payment method; change status (pending → processing →
  shipped → delivered, or cancelled) — updates live as soon as you
  change the dropdown
- **Customers** — see registered customers with order count and total
  spend

## Security notes (read before going live)

- Change `ADMIN_KEY` from the default — anyone with it can edit your
  catalogue and see every order and customer.
- Passwords are hashed with bcrypt; they're never stored or sent in
  plain text.
- Sessions live in server memory and reset if the server restarts —
  customers just log in again. Fine for a small shop; swap in a
  proper session store (Redis, or a database-backed one) if you need
  logins to survive restarts or plan to run more than one server
  instance.
- Deploy behind HTTPS. Cookies are set without `secure: true` here so
  local HTTP testing works — add that flag in production so session
  cookies are never sent over plain HTTP.
- Users, sessions, orders, products, password resets, notifications,
  rewards, contact messages, and flyer images all live in PostgreSQL — see
  `DATABASE_URL` in `.env.example`. There is no local JSON data left at all.

## Deploying it for real

This needs a host that keeps a Node process running with a **writable,
persistent disk** — not a static host (GitHub Pages, Netlify static)
and not most serverless function platforms, since those reset the
filesystem between requests and your orders/catalogue would vanish.

### 1. Get the code onto GitHub

```bash
cd myshopswift
git init
git add .
git commit -m "MyShopSwift"
```

Create an empty repo on GitHub, then:

```bash
git remote add origin https://github.com/<you>/myshopswift.git
git branch -M main
git push -u origin main
```

(`.gitignore` already excludes `node_modules/` and `.env`, so secrets
won't get committed.)

### Option A — Render

1. Go to [dashboard.render.com/blueprints](https://dashboard.render.com/blueprints)
   and connect the GitHub repo — Render will read `render.yaml` in
   this folder and set up the service and a persistent disk for `data/`
   automatically.
2. In the service's **Environment** tab, set `ADMIN_KEY` to a real
   password, and `PUBLIC_URL` to the `.onrender.com` URL Render gives
   you (or your custom domain once attached). Add `STRIPE_SECRET_KEY`
   if you want card payments.
3. Deploy. Render builds with `npm install` and runs `npm start`
   automatically per the blueprint.

If you'd rather not use the blueprint, create a new **Web Service**
manually, point it at the repo, set build command `npm install` and
start command `npm start`, then add a **Disk** mounted at `data/` so
your catalogue and orders survive redeploys.

### Option B — Railway

1. [railway.app](https://railway.app) → New Project → Deploy from
   GitHub repo → pick this repo. Railway detects Node automatically
   (`Procfile` / `package.json` `start` script).
2. In **Variables**, add `ADMIN_KEY`, `PUBLIC_URL` (the Railway-issued
   domain, or your own once attached), and `STRIPE_SECRET_KEY` if
   using card payments.
3. Add a **Volume** mounted at `/app/data` (or wherever your service
   root lands) so `data/*.json` persists across deploys — without
   this, every redeploy wipes your orders and catalogue back to
   whatever's in the repo.

### Option C — your own VPS

Install Node 18+, clone the repo, `npm install`, then keep it running
with `pm2` or a `systemd` service (`pm2 start server.js --name myshopswift`),
put Nginx or Caddy in front for HTTPS and your domain, and set the
same environment variables in the process manager's env file.

Whichever you pick: set real secrets only in the platform's dashboard
or process manager, never in a committed `.env`.

## About the Android/iOS apps

Native mobile apps are a genuinely separate project from this
website — different toolchains (Xcode/Android Studio), app store
developer accounts, code signing, and a review process on each store.
That's not something that can be produced alongside a web build like
this one.

The realistic, lower-cost path once the web platform above is stable:
wrap it with **Capacitor** (or Cordova) to ship the same web app as
installable Android/iOS apps with access to native features (push
notifications, camera, etc.), rather than building two separate native
codebases from scratch. That's still real work — app store accounts,
icons/splash screens, store listings, and review — but it reuses
everything built here instead of duplicating it.

## Brand Flyers carousel

A rotating "Featured Brands" carousel on the storefront, fed by images the
admin uploads — no product association needed. Logic lives in `flyers.js`.

- **Storage** — a single `flyers` table in PostgreSQL, metadata and the raw
  image bytes together (`image_data` is `bytea`). Uploads go through
  `multer.memoryStorage()`, so a file never touches the local disk at all —
  it goes straight from the upload into the database. This is deliberate:
  Render's free plan has no persistent disk, and even a paid plan's disk is
  one more thing to provision — Postgres was already required for
  everything else, so it's the simplest single place for this too. Images
  are served publicly at `/uploads/flyers/<id>` via a dedicated route in
  `server.js` that streams the bytes straight out of Postgres with the
  right `Content-Type` — the images themselves aren't sensitive, only
  uploading/deleting them is.
- **Admin (`Admin → Flyers`)** — upload one or more images in a single
  request (drag no, but multi-select works — `<input type="file" multiple>`
  posted as `multipart/form-data`), replace or delete any flyer, and
  reorder them with ↑/↓ controls. All of this requires the same admin key
  (`x-admin-key` header) as the rest of the admin panel.
- **Validation** — JPEG/PNG/WEBP/GIF only, 5MB max per image, up to 20
  images per upload batch, all enforced server-side via `multer` (the one
  new dependency this feature adds).
- **Customer-facing** — `GET /api/flyers` (public, no auth) returns flyers
  sorted by their admin-set order. The storefront carousel fetches this on
  page load: 0 flyers → the whole section stays hidden; 1 flyer → it's
  shown with no controls; 2+ → arrows, dot indicators, 5-second autoplay,
  and swipe gestures on touch devices.

## Rewards / Loyalty

A points-based rewards system lives alongside the rest of the app in
`rewards.js`, backed by five PostgreSQL tables:

- `rewards_settings` — the admin-configurable reward values
- `rewards_accounts` — one row per customer: points balance, referral
  code, who referred them, signup-bonus flag, qualifying-purchase count
- `rewards_transactions` — append-only ledger; every points change is a
  row here. This is the source of truth — the balance on the account row is
  just a cached total for fast reads.
- `rewards_referrals` — referral relationships and their reward status
- `rewards_vouchers` — vouchers generated by redeeming points

Rewards data lives in PostgreSQL, not JSON — see the "Backups" section
below for how to back up Postgres itself.

**How it works, briefly:**

- Customers see a **Rewards** tab inside the existing account modal:
  points balance, redeemable voucher value, their referral code/link,
  vouchers they've generated, a plain-English "how you earn points" list,
  and their points history.
- Reward values (signup bonus, £-per-point, referral bonus, review bonus,
  repeat-purchase bonus, points-per-£1 voucher) are set in **Admin → Rewards
  → Points Settings**, not hard-coded. Changing a setting only affects
  points earned from then on; past transactions keep the amount that was
  actually awarded, because the ledger stores the points, not a formula.
- Purchase points and the repeat-purchase bonus are awarded when an order's
  status is changed to **Delivered** (the qualifying/completed status for
  this project) — never just on order creation — and are reversed with a
  negative ledger entry if a delivered order is later moved off that status.
- A referral's reward goes to the referrer only after the referred
  customer's **first delivered order**, not at signup.
- Every award is idempotent (keyed by order ID, referral ID, or a
  `signup:<userId>` key), so re-processing the same event never double-pays.
- Product reviews: MyShopSwift doesn't have a review system yet, so
  `rewards.awardReviewPoints(userId, reviewId)` is a ready-to-call function,
  not a live endpoint — wire it in when reviews are built. It wasn't exposed
  as its own API route because a customer-facing endpoint that awards points
  for an arbitrary review ID, with no actual review to check it against,
  would let customers award themselves points.
- **Admin → Rewards** also has Overview (totals), Customers (search +
  manual point adjustments with a required reason), Transactions, Referrals,
  and Vouchers — all read-only except the settings form and the manual
  adjustment panel, both of which require the same admin key as the rest of
  the admin panel.

No new dependencies were added for this — `rewards.js` is Postgres-backed
(via the same `pg` connection pool `server.js` already uses) and otherwise
only uses Node's built-in `crypto`.

## Backups

Every piece of data this app stores — users, sessions, orders, products,
password resets, notifications, rewards, contact messages, and flyer images
— lives in PostgreSQL now. There is no local JSON data left to back up, so
the old `backup.js` file-snapshot mechanism has been removed entirely
(it's no longer required or called anywhere in `server.js`).

**Back up Postgres directly:**

- **Neon point-in-time recovery** — available on Neon's paid plans;
  restores your database to any point within the retention window with no
  extra setup on your part.
- **Scheduled `pg_dump`** — works on any Postgres, including Neon's free
  tier. Run it from anywhere with network access to your database
  (a scheduled GitHub Action, a cron job on another host, etc.), since
  Render's app instance itself has no persistent disk to store dump files
  on for later.

There is no `BACKUP_KEY`, `BACKUP_INTERVAL_HOURS`, `BACKUP_RETENTION`, or
`BACKUP_DIR` to configure anymore — none of those env vars do anything.

## Admin new-order notifications

Three channels, all triggered from one place — the moment an order actually
becomes real (Cash on Delivery/points at creation, card payment once Stripe
confirms it via the webhook or the client-side confirm fallback):

- **Dashboard** — a Notifications button in the admin header with an
  unread count, a
  panel (All/Unread), click a notification to jump straight to that order
  in the existing Orders tab (highlighted briefly), dismiss individual ones
  or mark all read.
- **Real-time** — Server-Sent Events (`GET /api/admin/notifications/stream`),
  not polling. The admin key is sent as a `?key=` query param for this one
  endpoint only, since a native `EventSource` can't set custom headers —
  every other admin endpoint still uses the `x-admin-key` header as before.
  Connections are authenticated on open, cleaned up on disconnect, and get a
  heartbeat comment every 25s to survive idle-connection timeouts on most
  hosts/proxies.
- **Browser/desktop** — uses the standard `Notification` API. The dashboard
  offers an "Enable desktop notifications" prompt only while permission is
  still undecided (`Notification.permission === "default"`) — the browser
  itself remembers a grant/denial across reloads, so nothing extra is
  stored to avoid re-prompting. Works in browsers without `Notification`
  support too — that channel just quietly does nothing, and the dashboard
  panel still works.
- **Email** — reuses the same `email.js`/SMTP config as password-reset
  emails, sent to `ADMIN_EMAIL`. Sending is fire-and-forget: it can never
  delay or fail the customer's order, and a missing/broken SMTP config just
  logs a warning — set `ADMIN_EMAIL` to enable it.

**Duplicate protection**: every notification is created via a `dedupeKey`
(`new_order:<orderId>`) — the first caller to report a given order creates
the one and only notification/broadcast/email for it; every other call
(webhook retries, the client confirm endpoint also firing, page
refreshes) is a safe no-op.

**Security**: every notification endpoint requires the same admin key as
the rest of the admin panel; customers have no route that can read, create,
or modify admin notifications.

### New environment variable

- `ADMIN_EMAIL` — where new-order emails are sent. Leave blank to disable
  just the email channel; dashboard and browser notifications work
  regardless.
