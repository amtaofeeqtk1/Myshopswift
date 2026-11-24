# MyShopSwift

A West African grocery + gadgets storefront for the UK market: customer
accounts, checkout with card payment or reward points, order
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
- `ADMIN_EMAIL` — your admin email (new-order alerts go here). The admin
  panel signs in with an email and password; see `.env.example`. The old
  `ADMIN_KEY` is no longer used.
- `STRIPE_SECRET_KEY` — optional. Add a real Stripe
  secret key to enable "Pay by Card" at checkout (Stripe Checkout
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
- Pay by Card via Stripe or use reward points; points may cover all or part of an order
- View their own past orders from the account panel

## What the admin panel does

Sign in to the admin panel, then:
- **Products / Categories** — add, edit, delete; **Publish live**
  pushes changes to the storefront immediately
- **Orders** — view every order with customer, items, total, delivery
  address, and payment method; change status (pending → processing →
  On the way to you → delivered, or cancelled) — updates live as soon as you
  change the dropdown
- **Customers** — see registered customers with order count and total
  spend

## Security notes (read before going live)

- Use a strong admin password — anyone who can sign in to the admin
  panel can edit your catalogue and see every order and customer.
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
2. In the service's **Environment** tab, set `ADMIN_EMAIL`, and `PUBLIC_URL` to the `.onrender.com` URL Render gives
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
2. In **Variables**, add `ADMIN_EMAIL`, `PUBLIC_URL` (the Railway-issued
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

- **Storage** — new and replacement flyer images are uploaded to Cloudinary
  (see "Image storage: Cloudinary" below); the `flyers` table keeps the
  order/name and the flyer's Cloudinary URL (`image_url`). Flyers uploaded
  before the move still have their bytes in `flyers.image_data` and keep being
  served at `/uploads/flyers/<id>` until `migrate-images-to-cloudinary.js` has
  migrated them (after which that URL redirects to Cloudinary). `image_data`
  is never emptied or deleted by the app.
- **Admin (`Admin → Flyers`)** — upload one or more images in a single
  request (drag no, but multi-select works — `<input type="file" multiple>`
  posted as `multipart/form-data`), replace or delete any flyer, and
  reorder them with ↑/↓ controls, with an upload progress bar and clear
  success/error messages. Requires an admin session, like the rest of the
  admin panel. Deleting a flyer removes the flyer, never its Cloudinary image.
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
becomes real (points at creation, card payment once Stripe
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

## AI shopping assistant

A chat widget on the storefront that helps customers find products from the real catalogue and add them to the normal basket.

- Code lives in `ai-assistant/` (`catalogue-search.js`, `tools.js`, `ai-service.js`, `validation.js`, `index.js`); the widget is `public/assets/ai-assistant.js` + `.css`, loaded by `public/index.html`.
- Endpoints: `POST /api/ai-assistant` (chat) and `GET /api/ai-assistant/status` (tells the page whether to show the widget).
- The OpenAI key stays on the server. Set `OPENAI_API_KEY` (required), plus optional `OPENAI_MODEL`, `AI_RATE_LIMIT_MAX`, `AI_DAILY_LIMIT` — see `.env.example`. With no key the widget is hidden and the rest of the site is unaffected.
- The model can only call four server-side tools: `search_products`, `get_product_details`, `list_categories`, `add_to_cart`. Prices, names and images always come from the catalogue, never from the model. `add_to_cart` validates product, quantity and brand, then the storefront adds the line to its existing basket through `window.MyShopSwiftCart` (defined in `boot()` in `index.html`). The assistant cannot place orders or take payment.
- Run the tests (no dependencies needed): `node --test tests/*.test.js`

## WhatsApp order enquiries and SMS order notifications

### WhatsApp (customer support shortcut — not automatic tracking)
A "Message us on WhatsApp" button opens a chat with the official number
(07739 320205) with the message "Hello MyShopSwift, I would like to check the
status of my order. My order reference is #xxxxxxxx." already typed in. It
appears on the order-confirmation dialog, in the account order history, and on
the Track Order page. The reference is the same 8-character reference shown in
emails and on Track Order, and it is the only thing put in the link — no name,
address, phone, email or total. The link is `https://wa.me/447739320205?text=…`
(WhatsApp's universal link: the app on Android/iOS, WhatsApp Web/Desktop on a
computer). The number lives in one place: `public/assets/whatsapp.js`. Admin
orders now show the same reference under the date, so staff can find an order
a customer quotes. Replies are sent by your team by hand; there is no
automatic WhatsApp status messaging.

### SMS notifications (Twilio)
Customers are texted at their checkout phone number, in addition to (and
independently of) the existing emails:

| Event | When |
|---|---|
| Order received | order created (every payment method, same moment as the email) |
| Payment confirmed | Stripe-verified payment only (signed webhook, or the return page after the server re-checks the Stripe session) |
| Processing / Dispatched / Delivered / Cancelled | admin changes the order status to that value |

There is no "out for delivery" order status in this project, so no SMS exists
for it. Each (order, event) is sent at most once, even if Stripe retries the
webhook, the customer refreshes the return page, or an admin re-saves a status
(`sms_notifications.dedupe_key` is unique). An SMS failure is logged and shown
in the admin dashboard but never affects the order, payment or status change.
If SMS is not configured, nothing is attempted or recorded.

**Phone numbers.** UK mobiles in any normal format (07…, +44…, 0044…) are
converted to +44…. Other countries need a +/00 prefix. UK landlines and
unusable numbers are recorded as "not sent" and never retried.

**Admin dashboard (Orders tab).** Under each order's status you will see each
SMS (attempted / queued / sent / delivered / not delivered / failed, with the
provider error code) and a **Retry** button on failed or undelivered ones.
Retry is atomic: it only works on failed/undelivered messages, cannot be
double-clicked into two sends, and refuses to send a stale message (e.g.
"dispatched" after the order is already delivered). Configuration is
server-side only (environment variables); the dashboard shows whether SMS is
configured but never any key.

**Required environment variables** (all optional — SMS stays off without them):
`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, and one sender: `TWILIO_FROM`
(alphanumeric ID such as `MyShopSwift`, or an E.164 Twilio number) or
`TWILIO_MESSAGING_SERVICE_SID`. Optional: `SMS_ENABLED=false` (kill switch).
Also set `NODE_ENV=production` and a public `https://` `PUBLIC_URL` on the
live server (delivery reports need it).

**Setup.**
1. Create a Twilio account, **upgrade it from trial and add credit** (trial
   accounts can only text verified numbers).
2. Copy Account SID and Auth Token from the Twilio Console into your host's
   environment variables (Render dashboard), plus `TWILIO_FROM`.
3. UK alphanumeric sender IDs work without pre-registration on Twilio, but
   customers cannot reply to them, and a "protected" brand name needs an
   approval letter (see Twilio's UK SMS guidelines). Use a Twilio number
   instead if you want replies.
4. Database: the server creates the `sms_notifications` table itself at
   startup. You can also run `add-sms-notifications.sql` against Neon first
   (idempotent, additive only).
5. Redeploy, then run the staging checklist below.

**Troubleshooting Twilio error 21705 ("The Messaging Service is invalid").**
Twilio returns it when the `MessagingServiceSid` it receives is not exactly
`MG` + 32 letters/digits (34 characters). It is about the *format of that one
value*, not your credentials or sender approval. If you use
`TWILIO_MESSAGING_SERVICE_SID`: it must be the Messaging Service's own SID from
Twilio Console > Messaging > Services (not the service name, the Account SID
`AC…`, or the alphanumeric sender's `AI…` SID), entered in Render without
quotes. The server now removes stray quotes/spaces/invisible characters, checks
the format at startup, and — if it is wrong — switches SMS off and logs
`SMS config problem — TWILIO_MESSAGING_SERVICE_SID is not a valid Messaging
Service SID…` (also shown in Admin > Orders) instead of failing every order's
text. When a Messaging Service SID is set it is the only sender sent to Twilio;
`TWILIO_FROM` is not used. The Messaging Service must belong to the same Twilio
account as `TWILIO_ACCOUNT_SID`.

**Staging checklist (needs real services, not covered by automated tests).**
Place a points-only order with your own mobile and confirm the text arrives; pay a
Stripe test-mode card order and confirm one "received" and one "payment" text;
change the order to Processing, Dispatched, Delivered and confirm each arrives
once and shows "delivered" in the admin (proves Twilio callbacks reach
`/api/sms/twilio-status`); try an invalid number and confirm the order still
succeeds.

### Tests
`npm test` runs the unit tests and `tests/e2e-sms-flow.js`, which starts the
real server against an in-memory fake database, fake Stripe and fake Twilio.
These prove the application logic; they do not prove real PostgreSQL, Twilio or
Stripe behaviour.

## Image storage: Cloudinary (product photos, category photos, brand flyers)

Uploaded images are stored in **Cloudinary**; PostgreSQL only keeps references
and metadata. Nothing uploaded from now on puts image bytes in the database.

**How uploading works.** In the admin, the Photo field (products and categories)
and the Flyers tab let you pick images from your phone's photos or your
computer. Photos preview straight away, show an upload progress bar, and can be
replaced or removed before saving; flyers show progress and clear
success/error messages. The browser shrinks big phone photos first (longest
side 1600px) and checks type/size; the **server** then re-checks the file's real
type from its bytes (JPG/PNG/WebP — plus GIF for flyers — up to 5MB), requires
an admin session, and uploads to Cloudinary with a signed request. The
Cloudinary API secret exists only in the server's environment; the browser
never talks to Cloudinary and never sees a key.

**Where things live.**
- Cloudinary: the images, under `myshopswift/products|categories|flyers/<random id>` (never overwritten).
- `products.image` / `categories.image`: the image's `https://res.cloudinary.com/...` URL (same column as before).
- `flyers.image_url` + `flyers.cloudinary_public_id` (two new nullable columns): the flyer's Cloudinary URL.
- `image_assets` (new table): one row per uploaded/migrated image — Cloudinary public id, URL, format, size, dimensions, original file name.
- `image_migrations` (new table): progress/audit log of the migration below.

**Delivery.** Pages ask Cloudinary for an appropriately sized version
(`f_auto,q_auto,c_limit,w_N` — best format for the visitor's browser, automatic
quality, width capped per place it's shown: cards 640, cart thumbnails 160,
product options 800, flyers 1400, admin thumbnails 96) via `public/assets/cdn-image.js`.
The database keeps the plain URL; the page builds the optimised link when it
draws the image, so there are no extra database queries.

**Images are never deleted automatically.** Replacing a photo only changes the
URL on the product/flyer. Removing a photo only clears that field (the product
stays). Deleting a flyer removes its row, not its Cloudinary image. The app has
no Cloudinary delete/rename call at all; clean-up, if ever wanted, is a manual
job in the Cloudinary console.

**Environment variables** (Render dashboard; also in `.env.example`):
`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
(optional `CLOUDINARY_FOLDER`, default `myshopswift` — use another value for a staging site).
**Set them before deploying this version**: until they are set, new photo and
flyer uploads are refused with a clear message (existing images keep
displaying, and the rest of the shop is unaffected).

### Migrating the existing images (PostgreSQL → Cloudinary)

Existing product/category photos live in the `product_images` table (served from
`/uploads/products/<id>.<ext>`) and existing flyers have their bytes in
`flyers.image_data`. `migrate-images-to-cloudinary.js` copies them all to
Cloudinary. It **never deletes, truncates or empties anything**; the old data
stays as the backup. It does not run automatically.

Run it from your own computer (or Render's Shell) with `DATABASE_URL` and the three
`CLOUDINARY_*` variables set, in this order:

1. **Take a database snapshot/branch first** (Neon: create a branch or note the restore point) — the last step edits product/category rows.
2. `node migrate-images-to-cloudinary.js --dry-run` — reads only; lists what would be migrated.
3. `node migrate-images-to-cloudinary.js --backup=./image-backup` — saves every original image + a SHA-256 manifest to a local folder. Keep it.
4. `node migrate-images-to-cloudinary.js --limit=3` — try a small batch, then open a few of the printed Cloudinary URLs.
5. `node migrate-images-to-cloudinary.js` — migrates the rest. Each image is uploaded under a fixed id (`myshopswift/legacy/...`, never overwritten), then its Cloudinary URL is fetched to prove it loads; only then is it recorded as migrated in `image_migrations`. **If anything fails, just run it again**: finished images are skipped, failed ones retried, and nothing is uploaded twice. Exit code is 1 if any image failed.
6. Check progress any time: `SELECT status, COUNT(*) FROM image_migrations GROUP BY status;`
7. Only when everything shows `migrated`: `node migrate-images-to-cloudinary.js --apply-references` — points products, categories and flyers at the new URLs (only for images that migrated *and* verified; relative `assets/...` paths and anything else are left alone).

From the moment an image is migrated and verified, its old `/uploads/...` URL
redirects to Cloudinary, so cached pages or old emails keep working. Keep
`product_images` and `flyers.image_data` until you've used the shop for a while
and are happy; retiring them is a separate manual decision (there is no script
that drops them).

### Staging checklist (needs your real Cloudinary account and database)
Upload a product photo from a real Android phone and an iPhone and from a
computer; Publish live; check it shows on the storefront; replace and remove a
photo; upload a category photo; upload, replace and reorder a flyer; confirm each
appears in the Cloudinary console under `myshopswift/`; run the migration steps
above on a copy/staging database first.

### Tests
`npm test` runs unit tests (Cloudinary client incl. Cloudinary's published
signature example, migration logic), SMS checks, `tests/e2e-product-images.js`
(real server against a fake database and a signature-verifying fake Cloudinary,
with and without credentials configured) and `tests/e2e-migration-cli.js` (runs
the real migration script as a separate process through dry run, backup,
partial failure, retry, apply-references and re-run). `tests/browser/product-upload.py`
drives a real Chromium (desktop + phone/tablet emulation; Python + Playwright;
fixtures via `tests/browser/make-fixtures.py`) and is run by hand. These prove
the application logic — not real Cloudinary, real PostgreSQL SQL, or real phones.
