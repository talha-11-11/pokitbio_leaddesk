# PokitBio Lead Desk

Every person who messages the **PokitBio Facebook page** or **@pokitbiogram on Instagram** becomes a lead automatically.
The dashboard then tracks for each lead:

- **Stage**: New → Contacted → Demo sent → Negotiation → Won / Lost (also drag-and-drop on the Pipeline tab)
- **Contacted date**: set automatically the first time you reply from the page; you can also set it by hand
- **Demo sent date**: one tap ("Today") or pick a date
- **Follow-ups**: dated reminders with a note, marked done/overdue, plus a Follow-ups tab (Overdue / Today / Upcoming)
- **Notes**: dated notes plus an automatic activity log (stage changes, demo, follow-ups)
- **Full conversation**: the Messenger/IG chat history for each lead
- Search, filters (Waiting for reply, Contacted but no demo, Overdue), CSV export, add leads by hand

---

## 1. Database: Neon (free)

1. Sign up at **neon.tech** and create a project (pick the region closest to your server, e.g. AWS Singapore or Frankfurt).
2. Click **Connect** and copy the **pooled** connection string (the host contains `-pooler`).
3. Put it in `DATABASE_URL`. The app creates its tables on first start, so you don't need to run any SQL.

The free plan (0.5 GB) holds hundreds of thousands of leads and messages. The database sleeps when idle and
wakes up on the next request. The first request after a quiet period takes about a second longer, and nothing is lost.

## 2. Run locally

```bash
cp .env.example .env      # fill in values
npm install
npm start                 # http://localhost:3000
```
Needs Node 18+.

## 3. Deploy (Render, free plan works)

1. Push this folder to a GitHub repo, then on Render choose **New → Web Service**.
2. Build: `npm install` · Start: `npm start` · Instance: **Free**
3. Add the env vars from `.env.example` (including `DATABASE_URL` from Neon).
4. All data is stored in Neon, so redeploys and restarts lose nothing.
5. **Keep it awake:** free Render apps sleep after 15 minutes without traffic, and a sleeping app can miss Meta webhooks.
   Set up a free monitor at **cron-job.org** or **UptimeRobot** that requests `https://YOUR-URL/healthz` every 10 minutes.
   You can also press **⟳ Sync inbox** at any time to pull in anything that was missed.

Your public URL (e.g. `https://pokitbio-leads.onrender.com`) is used below.

## 4. Connect Messenger + Instagram (Meta app)

**Before you start:** @pokitbiogram must be a **Professional (Business/Creator)** account linked to the PokitBio Facebook page.
In the Instagram app go to Settings → Messages and story replies → Message controls → turn on **Allow access to messages**.

1. Go to **developers.facebook.com → My Apps → Create App** and pick type **Business**.
2. Add the **Messenger** product and the **Instagram** product (the one for Instagram messaging).
3. **Generate the page token:** Messenger → Settings → Access Tokens → add the PokitBio page → **Generate token**.
   Put it in `META_PAGE_TOKEN`. (Tokens made this way from a long-lived user token don't expire. You can check it in the Access Token Debugger.)
4. **Get the IDs:**
   - `META_PAGE_ID`: Page → About → Page transparency, or `GET /me?access_token=PAGE_TOKEN`
   - `META_IG_ID`: `GET /{PAGE_ID}?fields=instagram_business_account&access_token=PAGE_TOKEN`
5. **App Secret:** App Settings → Basic → App Secret goes in `META_APP_SECRET`.
6. **Webhooks:**
   - Messenger → Settings → Webhooks: Callback URL = `https://YOUR-URL/webhook`, Verify token = your `META_VERIFY_TOKEN`.
     Subscribe the page to the fields **messages** and **message_echoes**.
   - Instagram → Webhooks: same URL and token. Subscribe to **messages** (echoes are included).
7. **Permissions:** `pages_messaging`, `pages_manage_metadata`, `pages_read_engagement`, `pages_show_list`,
   `instagram_basic`, `instagram_manage_messages`, `business_management`.
   - While the app is in **Development mode**, it works for people who have a role on the app (you, plus testers you add). Use this to test.
   - To capture messages from **real customers**, switch the app to **Live**. This needs **App Review** with Advanced Access for
     `pages_messaging` and `instagram_manage_messages`, plus **Business Verification** for PokitBio. Use `https://YOUR-URL/privacy`
     as the privacy-policy URL.
8. Open the dashboard and press **⟳ Sync inbox** to import existing Messenger + Instagram conversations.
   After that, new messages arrive live through the webhook.

## How it decides things
- Message from a customer: creates the lead if it's new, stores the message, increases the unread count.
- Reply from your page (Business Suite, the Messenger/IG app, anywhere): stored as "You:". On the first reply the lead is marked
  **Contacted** with that date.
- Picking **Demo sent** fills in today's demo date (and the contacted date if it's empty).
- Follow-ups due before today are shown in red as overdue.

## API (all `/api/*` routes need header `x-admin-key: ADMIN_PASSWORD`)
`GET /api/leads` · `GET /api/leads/:id` · `POST /api/leads` · `PATCH /api/leads/:id` · `DELETE /api/leads/:id`
`POST /api/leads/:id/notes` · `POST /api/leads/:id/followups` · `PATCH /api/followups/:id` · `GET /api/followups`
`GET /api/stats` · `POST /api/sync` · `GET /api/export.csv`
