# PokitBio — business app

One app for running PokitBio. It works in a browser on a laptop and installs on your phone from Chrome.

| Section | What it does |
|---|---|
| **Dashboard** | This month's income, expenses, profit, Meta ads spend (average per day and cost per lead), pending payments, subscription and payroll costs, a 12-month chart, and a "Needs attention" list (overdue follow-ups, bills due, unpaid salaries, apps down) |
| **Leads** | Every Messenger and Instagram DM becomes a lead automatically, with name, phone and business picked up from the message. Contacted and demo are marked by hand. Each lead has **demos sent** (picked from your demo list), a **call log** (what was discussed, outcome, next step), follow-ups and notes. There's also a Pipeline board |
| **Projects** | Ongoing and completed work (Upwork, local, direct): budget, received, pending, deadline, live link. **Payment** records income, and on Upwork the 10% fee is saved as an expense. **Completed** can add the project to your demo list and the uptime checks |
| **Upwork** | Connects available (you set the balance, buying adds, proposals subtract), proposals log with status and win rate, earned vs spent (Connects, Freelancer Plus, service and withdrawal fees), net and return, 12-month chart, top clients. A hired proposal becomes a project in one tap |
| **Payoneer** | Money received (from Upwork, which isn't counted twice, or from direct clients, which is added to Income), withdrawals to bank with the rupees that arrived, fees, and the balance (you set it; new entries move it). **Upload statement (PDF or CSV)** for any period: every row is classified for you to check, totals are calculated, opening + transactions is checked against the closing balance, and anything already imported is skipped |
| **Reminders** | Every follow-up, call, demo or meeting has a date and time. Your phone or laptop gets a notification **1 hour before** (or 30 min / 2 h / 1 day / none), plus a 9:00 AM summary of what's due today. Tapping a notification opens that lead. Turn it on in **Settings → 🔔 Reminders** on each device (install the app first) |
| **Income** | Payments received or pending, in any currency (converted to PKR) |
| **Expenses** | Every cost by category. **📣 Meta ads** is a one-tap daily entry |
| **Subscriptions** | Claude, hosting, email, domains and so on. Tap **Paid** to record the expense and move the next due date forward |
| **Staff** | Team members on salary, commission or freelance. **Pay** records the salary as an expense for that month |
| **Accounts & reports** | Monthly profit and loss, top clients, month-by-month table, a ledger CSV, and **PDF reports**: pick a type (Business, Money (P&L), Sales & leads, Meta ads, Upwork, Payoneer, Projects, Team & costs, Apps status, or Custom with ticked sections) for a day, week, month, year or custom dates. Each report has its own headline figures (with change vs the previous period) and highlights |
| **Apps on Render** | Checks each app's URL to see whether it's up. With a Render API key it also shows every service and its last deploy (live, failed or building) |
| **App usage** (Apps on Render) | For each Render app, every day: how many times it was **opened**, how long it was **awake**, and how many times it **woke up** from sleep. Tap an app for daily charts and a 24-hour timeline of when it was awake. Needs `RENDER_API_KEY`. Daily totals are saved, so history grows beyond what Render keeps. Render apps are checked through Render's API (not visited), and this app's own pings are subtracted, so the numbers aren't inflated |
| **Settings** | Exchange rates, the demo list, install, log out |

## Update an existing deploy
Copy all the files over your repo (new: `finance.js`, `ops.js`, `projects.js`, `payoneer.js`, `reminders.js`, `usage.js`, `extract.js`, `public/app.js`, `public/sw.js`,
`public/manifest.webmanifest`, `public/icons/`), then push. Render runs `npm install` (which adds `pdfkit` and `chart.js`) and redeploys.
New database tables are created automatically on start-up, and your existing leads are kept.

## Environment variables (Render → Environment)
| Variable | |
|---|---|
| `ADMIN_PASSWORD` | Login password |
| `DATABASE_URL` | Neon pooled connection string |
| `APP_TZ` | `Asia/Karachi` |
| `META_*` | Messenger and Instagram settings (see below) |
| `RENDER_API_KEY` | *Optional.* Create it under Render → Account settings → API keys. Shows all your services and their deploy status |
| `MONITOR_INTERVAL_MIN` | *Optional*, default `30`. How often each app URL is checked |

The app keeps itself awake automatically: Render provides `RENDER_EXTERNAL_URL`, and the app pings its own `/healthz` every 10 minutes.

## Install on your phone
Open the app's URL in **Chrome on Android**, then tap **⬇ Install** at the top, or the ⋮ menu → **Install app**. It gets a home-screen icon and opens full screen like a normal app.
On a laptop, click the install icon at the right of Chrome's address bar.

## Meta (Messenger + Instagram) setup
Webhook URL: `https://YOUR-APP.onrender.com/webhook`. The verify token is your `META_VERIFY_TOKEN`.
- Messenger: page token in `META_PAGE_TOKEN`, page ID in `META_PAGE_ID`. Subscribe to `messages` and `message_echoes`.
- Instagram (Unified login): system-user token in `META_IG_TOKEN`, account ID in `META_IG_ID`. Subscribe to `messages`.
- Privacy policy URL for Meta: `https://YOUR-APP.onrender.com/privacy`.

## Notes
- Money is stored in its original currency together with the PKR rate on that day. Changing the rates in Settings doesn't change old entries.
- Free Render apps fall asleep. Each monitor check wakes them, which uses free instance hours, so keep `MONITOR_INTERVAL_MIN` at 30 or more.
- Ledger CSV (Accounts) gives your accountant every income and expense line for a month.

## Upwork data
`data/upwork-import.json` is an export of your Upwork account (contracts, payments, fees, Connects purchases, proposals and the Connects balance), made through Claude's Upwork connector.
- On startup the app imports it automatically. Every row carries its Upwork record id, so restarting or importing again never creates duplicates.
- To refresh, ask Claude "sync my Upwork", then use **Upwork → ⬆ Import Upwork file**. You can also replace the file in the repo and push.
- The file contains client names and earnings. Keep the repo **private**, or remove the file after the first deploy (the data stays in Neon).

## Design
Navy sidebar grouped into Overview / Sales / Money / Team / System (it scrolls on short screens), a top bar with lead search, a bell for what's due today, and **New**. Under the logo, the live **Today** panel shows follow-ups due, calls and demos, the next appointment, money received today, and app status. Font: IBM Plex Sans, with aligned numbers.
