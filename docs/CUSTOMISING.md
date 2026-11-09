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

Fixed categories the reader assigns itself: *Salary*, *From people*, *To people*, *Refunds*, *Cash*, *Bank fees*, *Between my accounts* and *Money in* / *Other* as fall-backs.

## Budgets

Tap **Set budgets** on the dashboard (or **Edit** above the budget rings) and enter a monthly amount for the categories you want to watch. They are stored in a **Budgets** tab. Rings turn amber at 80% and pulse red when you go over, and the monthly email reports each budget.

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

- Colours are CSS variables at the top of `Dashboard.html` (`--accent`, `--in`, `--out`, `--bg` …), with separate values for dark mode.
- Pixel icons are 10×10 grids in the `PX` object; `CAT_ICON` maps categories to icons.
- The savings mountain's look per month: under 0% kept is bare earth, 0–20% green grass, 20–40% pines, 40%+ sakura (`mtTier` in `Dashboard.html`).
- All animation respects the iPhone's **Reduce Motion** setting.
