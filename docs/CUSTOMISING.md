# Customising

Most settings live in the Google Sheet, so you can change them without touching code.

## Settings tab

| Row | Example | Effect |
|---|---|---|
| My names as banks write them | `JOHN A SMITH, JOHN SMITH` | Transfers to or from these names are treated as moves between your own accounts and left out of totals. |
| Credit cards | `*1234: 10000, *5678: 5000` | Shows used / available against each limit. Card bill payments are matched to the debit from your account and not counted twice. |
| Usual payday | `25` | Estimates the next payday for *Left until payday* and the daily allowance. The real date comes from the salary SMS. |
| No-spend streak limit | `20` | A day at or under this amount still keeps your streak alive. |

## Categories

The **Categories** tab has one row per category, with words to look for in the merchant name, comma separated:

```
Coffee & tea | coffee, cafe, starbucks, costa, tim hortons, karak
```

- Matching is case-insensitive and looks for the word anywhere in the merchant name.
- The first matching row wins, so put more specific categories higher.
- Add new categories by adding a row. They appear in the dashboard's category picker.
- **Learning:** tap a transaction on the dashboard, pick a category and keep *Always use this category* ticked. The merchant name is added to that row, so future payments there are sorted automatically.

A plain account debit with no name (e.g. *AED 25.00 was debited from your account …*) is filed under **To people**, since it is usually money sent to a friend; AED 5 or less counts as *Bank fees*.

Fixed categories the reader assigns itself: *Salary*, *From people*, *To people*, *Refunds*, *Cash*, *Bank fees*, *Between my accounts* and *Money in* / *Other* as fall-backs.

## Budget plan and budgets

Tap **Set up my plan** on the Budget plan panel (or **Edit** above it or above the budget rings). Enter your **monthly salary** and a monthly amount for the categories you want to watch. The editor shows what is left as savings while you type.

- The salary is stored in **Settings → Monthly salary (for the budget plan)** and budgets in a **Budgets** tab.
- The plan groups categories into **Fixed bills** (Rent, Bills & phone), **Everyday** (Groceries, Food, Coffee & tea, Fuel, Transport, Health, Government & post, Subscriptions, Education) and **Lifestyle** (everything else). Change the groups in `PLAN_GROUPS` in `Dashboard.html`.
- Whatever you don't budget is your savings goal. The panel shows whether this month's spending keeps you on track.
- Rings turn amber at 80% and pulse red when you go over, and the monthly email reports each budget.
- To give new installs a starter plan, fill `PLAN_DEFAULT` near the top of the budget-plan section in `Code.gs`.
- A **Rent** category is included. If you pay rent by bank transfer it may first appear under *To people*: tap it, choose Rent and keep *Always use this category*.

## Pay jar

Before your salary arrives, every bit of money in since the last expected payday fills the jar (salary, transfers, refunds, cash), and a full jar equals your planned salary. After the salary, the jar is salary plus other money in, minus what you spent.

## Salary

A message is treated as salary when it mentions **WPS**, **salary** or **payroll**. The salary-to-salary view starts at the latest salary and runs until the next one. You can also add a salary by hand with **+ Cash** and the category *Salary*.

## Time zone and currency

- `TZ` near the top of `Code.gs` controls dates, the 10 pm summary day and the monthly email (IANA name such as `Asia/Dubai`).
- Totals add the **AED** amounts only. Payments in other currencies are listed and marked but not added. To use another home currency, replace the `'AED'` checks in `Code.gs` and `Dashboard.html` with your code (search for `AED`), and set the SMS automation's *Message Contains* to that code.

## Adding a bank or message format

All message reading is in `parseMessage` in `src/parser.js` (and the same function inside `Code.gs`).

1. Copy a real message from your bank and **replace names, account digits and balances with fake ones**.
2. Add a test to `tests/parser.test.js`:

   ```js
   check('AED 45.00 spent on card ****1234 at SAMPLE SHOP on 01/01/26.', 'MyBank', { type: 'Out', amount: 45, party: 'Sample Shop' });
   ```
3. Run `node tests/parser.test.js`. If it fails, add a pattern to `parseMessage` near the similar ones (purchases, credits, transfers). Each pattern returns `out({ type, flow, kind, amount, currency, party, account })`.
4. To name the bank, add it to the `BANKS` list at the top: `['My Bank', /mybank|my bank/i]`.
5. Copy the updated function into `Code.gs`, save and deploy a new version.

Messages the reader doesn't understand are saved in the **Review** tab with the sender, so you can see exactly what to add. Use **+ Cash** on the dashboard to enter them by hand meanwhile.

## Look and feel

- Colours, corner radii, shadows and fonts are CSS variables at the top of `Dashboard.html` (`--brand`, `--accent`, `--in`, `--out`, `--bg`, `--hero`, `--radius-xl` …), with separate colour values for dark mode. `--brand` is the lime used for buttons and selection; the `--hero-*` set colours the big first card; the `--dock-*` set colours the bottom dock and side rail.
- The logo files (mark, lockups, app icon) are in `docs/brand/`.
- Pixel icons are 10×10 grids in the `PX` object; `CAT_ICON` maps categories to icons.
- The savings mountain's look per month: under 0% kept is bare earth, 0–20% green grass, 20–40% pines, 40%+ sakura (`mtTier` in `Dashboard.html`).
- The All time **mood piggy** is drawn on a 64×48 canvas by `MoodPig` in `Dashboard.html` (`sceneCrack` for a month where more went out, `scenePropeller` for one where you kept more). The fire is a small pixel-fire simulation (`Fire`).
- Panels: every titled section can be collapsed. Which ones start collapsed is set in `FOLD_DEFAULT`.
- Light / dark: the switch next to Refresh flips between the two (the first visit follows the phone). Colours for both live in the CSS variables at the top.
- All animation respects the iPhone's **Reduce Motion** setting.
