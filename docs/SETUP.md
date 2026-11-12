# Setup guide

About 15 minutes on a computer, then 10 minutes on your iPhone. You only do this once.

**Contents**
1. [Create the Google Sheet](#1-create-the-google-sheet)
2. [Add the script](#2-add-the-script)
3. [Choose your secret key and time zone](#3-choose-your-secret-key-and-time-zone)
4. [Run setup once](#4-run-setup-once)
5. [Deploy the web app](#5-deploy-the-web-app)
6. [Your two links](#6-your-two-links)
7. [Fill in Settings](#7-fill-in-settings)
8. [Turn on the monthly email (optional)](#8-turn-on-the-monthly-email-optional)
9. [Updating later](#9-updating-later)
10. [Changing your key](#changing-your-key)

---

## 1. Create the Google Sheet

1. Go to [sheets.new](https://sheets.new) while signed in to your Google account.
2. Name it **MoneyLoop** (any name works).

You don't need to add any tabs or columns — the script creates them.

## 2. Add the script

1. In the sheet, open **Extensions → Apps Script**. A new tab opens with a file called `Code.gs`.
2. Delete everything in `Code.gs` and paste the full contents of [`src/Code.gs`](../src/Code.gs).
3. Click the **+** next to *Files* → **HTML**, name it exactly `Dashboard` (Apps Script adds `.html`).
4. Delete the sample content and paste the full contents of [`src/Dashboard.html`](../src/Dashboard.html).
5. Click the project name (*Untitled project*) and rename it **MoneyLoop**.
6. Press **Ctrl+S** / **Cmd+S** to save.

> Because you opened Apps Script from the sheet, the script is linked to it and `SHEET_ID` can stay empty. If you create the script separately at script.google.com, put your sheet's ID (the long code in its URL between `/d/` and `/edit`) in `SHEET_ID`.

## 3. Choose your secret key and time zone

At the top of `Code.gs`:

```js
var SHEET_ID = '';
var KEY = 'CHANGE-ME-TO-A-LONG-RANDOM-SECRET';
```

- Replace the `KEY` value with a long random string — at least 20 letters and numbers, no spaces. A password manager's generator is ideal. Example shape: `k7Qm2xR9vTnB4wLp8sYe`.
- A little further down, set `TZ` to your time zone if you are not in the UAE, for example `'Asia/Riyadh'`, `'Asia/Kolkata'` or `'Europe/London'`.

Save again.

## 4. Run setup once

1. In the toolbar, choose **setup** from the function menu next to **Run**, then click **Run**.
2. Google asks for permission. Click **Review permissions**, choose your account, then **Advanced → Go to MoneyLoop (unsafe) → Allow**.
   The warning appears for every personal script that Google hasn't reviewed. It is your own code running in your own account.
3. Back in the sheet you now have the tabs **Transactions**, **Categories**, **Settings** and **Review**. An **Overview** tab with charts and **Budgets** tab are added the first time you open the dashboard or set a budget.

## 5. Deploy the web app

1. Click **Deploy → New deployment**.
2. Click the gear next to *Select type* and choose **Web app**.
3. Set:
   - **Description:** `MoneyLoop`
   - **Execute as:** `Me`
   - **Who has access:** `Anyone`
4. Click **Deploy** and authorise again if asked.
5. Copy the **Web app URL**. It looks like `https://script.google.com/macros/s/AKfy…/exec`.

"Anyone" is needed so your iPhone Shortcuts can reach the script without signing in. Every request is rejected unless it carries your secret key.

## 6. Your two links

Build these by adding your key to the Web app URL:

| Link | Format | Used for |
|---|---|---|
| **Dashboard** | `WEB_APP_URL?key=YOUR_KEY` | Opening the dashboard (bookmark it, add it to your Home Screen) |
| **Daily summary** | `WEB_APP_URL?key=YOUR_KEY&action=summary` | The 10 pm notification |

Open the dashboard link on your computer. You should see an empty month with the message that there are no transactions yet.

Send both links to yourself (for example in Notes) so you can paste them on your iPhone. Treat them like a password.

Now continue with **[iPhone Shortcuts](IPHONE-SHORTCUTS.md)**.

## 7. Fill in Settings

Open the **Settings** tab in the sheet:

| Row | What to put |
|---|---|
| Secret key | Filled in by setup as a reminder. The script itself uses `KEY` in `Code.gs`. |
| My names as banks write them | Your name exactly as your banks print it in transfer messages, comma separated, e.g. `JOHN A SMITH, JOHN SMITH`. Transfers to or from these names count as moves between your own accounts. |
| Home currency | `AED` (totals only add this currency). |
| Credit cards | Card endings and limits, e.g. `*1234: 10000, *5678: 5000`. Purchases on these cards are spending; paying the card bill is an own transfer. |
| Usual payday | Day of the month your salary normally arrives, e.g. `25`. Used to estimate days left until payday. |
| No-spend streak limit | AED a day that still counts as a no-spend day (`0` means nothing at all). |
| Monthly salary (for the budget plan) | Your usual monthly salary. Easiest to set from the dashboard: **Budget plan → Set up my plan**. A full pay jar equals this amount. |

The last four rows appear automatically the first time the dashboard loads.

## 8. Turn on the monthly email (optional)

1. In Apps Script, choose **setupMonthlyReport** in the function menu and click **Run**.
2. Allow the two new permissions (send email as you, run on a schedule).

It sends a preview of this month straight away, then a full report for the previous month on the 1st of every month at 8 am, to the Google account that owns the script.

## 9. Updating later

When you paste a newer `Code.gs` or `Dashboard.html`:

1. Save.
2. **Deploy → Manage deployments → ✏️ Edit** on your existing deployment.
3. Under **Version**, choose **New version**, then **Deploy**.

Always edit the **same** deployment. *New deployment* creates a second URL, and your Shortcuts and bookmarks would keep using the old code.

## Changing your key

1. Put the new key in `KEY` at the top of `Code.gs` (and, for your own reference, in the Secret key row of **Settings**).
2. Save and deploy a new version (step 9).
3. Update the `key` field in both iPhone automations, the daily summary link and your Home Screen bookmark.
