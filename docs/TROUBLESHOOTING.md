# Troubleshooting

## The dashboard still shows the old version after I changed the code

You probably made a **new deployment** instead of updating the existing one, or saved without deploying. Go to **Deploy → Manage deployments → ✏️ Edit** on the deployment your links use, choose **Version → New version**, then **Deploy**. Archive any extra deployments so you only have one. Then reload the dashboard (on iPhone, close it and open it again).

## "Not allowed"

The key in the link or the Shortcut doesn't match `KEY` in `Code.gs`. Check for spaces or a missing character. After changing `KEY`, deploy a new version.

## "Authorization required" / the page asks for permissions

New features (like the monthly email) can need new permissions. Open the script, pick any function such as `setup`, click **Run** and approve. The web app works again afterwards.

## A payment didn't appear

Open **Apps Script → Executions**. Each SMS or Wallet tap that reached the script is listed as `doPost`.

- **Nothing listed** → the automation didn't run or stopped early. Check:
  - **Run Immediately** is selected (not *Run After Confirmation*).
  - For Wallet: **Filter Merchants** shows *Choose* (no merchants selected), all categories are ticked, the card is selected, and you paid with the iPhone (not the Watch).
  - For Wallet with location: Shortcuts has location permission (*While Using the App*, Precise Location on).
  - For SMS: the message really contains the text in *Message Contains* (e.g. `AED`), and your bank sends SMS, not only app notifications.
- **Listed but no row** → the message wasn't understood. Look in the **Review** tab, then see [Adding a bank or message format](CUSTOMISING.md#adding-a-bank-or-message-format).

Turning on **Notify When Run** and adding **Show Notification → Contents of URL** to an automation shows you exactly what happened on every run.

## The spending map is empty

Pins only appear for Wallet taps that sent `lat` and `lng`. Add **Get Current Location** before *Get Contents of URL* and the two fields, as in [iPhone Shortcuts](IPHONE-SHORTCUTS.md#2-apple-pay-taps-wallet). If the bank SMS arrives first, the location is added to that row a moment later.

## A payment is counted twice

The SMS and the Wallet tap are merged when the amount matches and they arrive within 20 minutes. If your bank's SMS shows a different amount (fees, currency conversion) they stay separate: tap one and choose **Remove**.

## A transfer between my own accounts is counted as spending or income

Add your name exactly as the bank writes it to **Settings → My names**. For a one-off, tap the row on the dashboard, tick **Between my own accounts (not counted)** and Save.

## The credit card shows the wrong available amount

Available comes from the latest *available balance* in your card SMS. Make sure the card ending and limit are in **Settings → Credit cards** (e.g. `*1234: 10000`).

## Numbers look slightly off

The *Money in / Money out / Net* row is rounded to whole units; the big number shows decimals. Transfers between your own accounts and credit-card bill payments are left out of both income and spending on purpose.

## The 10 pm notification is empty or says "Not allowed"

Use the **Daily summary link** (`…/exec?key=YOUR_KEY&action=summary`) with method **GET**, and set the notification text to **Contents of URL**.

## I didn't get the monthly email

Run `setupMonthlyReport` once from the editor and approve the permissions. Check **Triggers** (clock icon) for a `monthlyReport` trigger. The email goes to the Google account that owns the script; check Spam the first time.
