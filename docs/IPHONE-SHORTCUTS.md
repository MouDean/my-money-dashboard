# iPhone Shortcuts

Three automations do the capturing. Open the **Shortcuts** app → **Automation** tab → **+** (or *New Automation*) for each one.

You need your **Web app URL** (ends in `/exec`), your **secret key**, and your **Daily summary link** from the [setup guide](SETUP.md#6-your-two-links).

---

## Before you start: switch your banks to SMS

iOS doesn't let any app or automation read other apps' notifications, but Shortcuts *can* read SMS. In each bank's app or online banking, set transaction alerts to **SMS** (many banks let you choose SMS, app notification or both).

Wallet taps are captured separately (automation 2), so cards you only use with Apple Pay still show up even without SMS. The SMS adds the balance and catches non-Apple-Pay payments, transfers and salary.

---

## 1. Bank SMS

**Trigger**
1. Choose **Message**.
2. **Message Contains:** `AED` (use your currency code if different; add one automation per currency if you have several).
3. Leave *Sender* empty so all banks are included.
4. Choose **Run Immediately** and turn **Notify When Run** off.
5. Tap **Next → New Blank Automation**.

**Action**
1. Add **Get Contents of URL**.
2. URL: your **Web app URL** (without `?key=`).
3. Tap the arrow to show more options:
   - **Method:** `POST`
   - **Request Body:** `JSON`
   - Add these fields (all type *Text*):

| Key | Value |
|---|---|
| `key` | your secret key |
| `source` | `sms` |
| `text` | **Shortcut Input** → tap it → **Content** |
| `sender` | **Shortcut Input** → tap it → **Sender** |

4. Tap **Done**.

## 2. Apple Pay taps (Wallet)

**Trigger**
1. Choose **Wallet** (*When I tap…*).
2. Select all the cards you use with Apple Pay.
3. Leave all **categories** ticked, and make sure **Filter Merchants** says **Choose** (no merchants selected). If it says *Any of N merchants*, the automation only runs at those shops.
4. **Run Immediately**, and **Notify When Run** off once you have tested it.
5. **Next → New Blank Automation.**

**Actions**
1. Add **Get Current Location** (precision *Nearest Hundred Meters* is fine; *Best* is more exact but slower).
2. Add **Get Contents of URL** with the same URL, `POST`, `JSON`, and these fields:

| Key | Value |
|---|---|
| `key` | your secret key |
| `source` | `wallet` |
| `merchant` | **Shortcut Input** → **Merchant** |
| `amount` | **Shortcut Input** → **Amount** |
| `card` | **Shortcut Input** → **Card or Pass** |
| `lat` | **Current Location** → **Latitude** |
| `lng` | **Current Location** → **Longitude** |

3. Optional but recommended while testing: add **Show Notification** with **Contents of URL**. Each tap then shows the dashboard's reply, e.g. *Saved*, *Matched with Wallet* or *Added location to the SMS payment*.

**Location permission:** Settings → Privacy & Security → Location Services → **Shortcuts** → *While Using the App*, with **Precise Location** on. Without it, the location step fails and nothing is sent.

> Wallet automations only run for payments made with the **iPhone itself**. Apple Watch payments don't trigger them; those are still captured by the bank SMS.

When the bank SMS and the Wallet tap describe the same payment (same amount, within 20 minutes), the sheet keeps one row: the merchant and location from Wallet, and the balance from the SMS.

## 3. Daily summary at 10 pm

1. Choose **Time of Day**, `10:00 PM`, **Daily**, **Run Immediately**.
2. Add **Get Contents of URL** with your **Daily summary link** (method `GET`).
3. Add **Show Notification** and set its text to **Contents of URL**.

You'll get something like:

```
Mon 9 Nov: spent AED 86.50 (3)
Top: Food 52.00, Coffee & tea 18.00, Fuel 16.50
November so far: spent AED 1,240.00, received AED 15,000.00
Since payday: spent AED 2,140.00 of 15,000.00 · AED 590.00/day for 22 days
```

## 4. Dashboard on the Home Screen

1. Open your **Dashboard link** in Safari.
2. Tap **Share → Add to Home Screen**, name it **MoneyLoop**.

To use a custom icon, create a shortcut with the action **Open URLs** (your dashboard link), then **Share → Add to Home Screen** and tap the icon to choose a photo — for example [`docs/screenshots/app-icon.png`](screenshots/app-icon.png).

## Test it

1. In the Wallet automation, press **▶** at the bottom of the editor. With no real payment it should say **"Skipped: no amount from Wallet"**, which proves the connection works.
2. Make a small Apple Pay payment. Within seconds it appears in the dashboard (pull to refresh or tap **Refresh**).
3. If something doesn't show up, see [Troubleshooting](TROUBLESHOOTING.md).
