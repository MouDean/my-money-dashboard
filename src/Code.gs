/* My Money - turns bank SMS and Apple Pay taps into a personal money dashboard.
   https://github.com/MouDean/my-money-dashboard  (MIT licence)

   SETUP: change the two lines below, then follow the README. */
var SHEET_ID = '';            // leave empty if this script was opened from the sheet (Extensions > Apps Script)
var KEY = 'CHANGE-ME-TO-A-LONG-RANDOM-SECRET'; // your secret key: used in your Shortcuts and dashboard link
// ===================== Message reader (pure functions) =====================
// Reads a bank SMS or Wallet payment and turns it into one transaction.
// Types: Out (money spent/sent), In (money received), Own (between my own
// accounts, left out of totals), Info (a bank confirmation, kept for matching only).

var CURRENCIES = 'AED|USD|EUR|GBP|SAR|QAR|KWD|BHD|OMR|EGP|JOD|INR|PKR|TRY|CHF|CAD|AUD|JPY|CNY';

var BANKS = [
  ['ADCB', /ADCB/i], ['Al Hilal', /al ?hilal/i], ['ADIB', /ADIB/i],
  ['FAB', /\bFAB\b|first abu dhabi/i], ['Emirates NBD', /\bENBD\b|emirates ?nbd/i],
  ['Mashreq', /mashreq/i], ['Emirates Islamic', /emirates ?islamic|\bEIB\b/i],
  ['DIB', /\bDIB\b|dubai islamic/i], ['RAKBANK', /rak ?bank/i], ['CBD', /\bCBD\b/i],
  ['Wio', /\bwio\b/i], ['Liv', /\bliv\b/i], ['HSBC', /hsbc/i], ['Citi', /\bciti/i],
  ['Apple Pay', /apple ?card/i]
];

function num_(s) { return Math.round(parseFloat(String(s).replace(/,/g, '')) * 100) / 100; }
function squash_(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
// A person's name from a transfer line: "AANI Transfer, FAB SARA AHMED KHAN" -> "Sara Ahmed Khan".
function personName_(s) {
  s = squash_(s).replace(/^(?:(?:AANI|IPP|Instant|Inward|Outward|Local|Fund|Funds|Mobile|Online|Internal|Own)\s+)*(?:Payments?|Transfers?|Remittances?)\s*(?:from|by)?\s*[,:\-]?\s*/i, '');
  s = s.replace(/^(?:FAB|FAM|FGB|ADCB|ADIB|ENBD|EIB|DIB|RAK|RAKBANK|CBD|NBF|MASHREQ|HSBC|CITI|WIO|LIV|AJMAN|SIB|UAB|NBQ|CBI|ALHILAL|EBI|ABK|ZAND|RUYA)\s+/i, '');
  return s;
}
function title_(s) {
  s = squash_(s).replace(/[.,;:]+$/, '').replace(/[ ,]+(U\.?A\.?E|AE|ARE)$/i, '');
  if (s && s === s.toUpperCase()) s = s.toLowerCase();
  s = s.replace(/(^|\s)([a-z])/g, function (m, a, c) { return a + c.toUpperCase(); });
  return s;
}

function detectBank(sender, text) {
  var i;
  for (i = 0; i < BANKS.length; i++) if (BANKS[i][1].test(sender || '')) return BANKS[i][0];
  if (/account ending with \d+/i.test(text) && /(new balance|balance:)/i.test(text)) return 'Al Hilal';
  if (/Trx\. of|card bal/i.test(text)) return 'ADIB';
  for (i = 0; i < BANKS.length; i++) if (BANKS[i][1].test(text || '')) return BANKS[i][0];
  return squash_(sender) || 'Other';
}

function findBalance(t) {
  var re = /bal(?:ance)?\.?\s*(?:is|:)?\s*(?:AED\s*)?([\d,]+\.\d{1,2})/gi, m, last = '';
  while ((m = re.exec(t))) last = m[1];
  return last ? num_(last) : '';
}

function nameTokens_(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z؀-ۿ ]/g, ' ').split(/\s+/)
    .filter(function (w) { return w.length > 1; });
}

// "JOHN A SMITH", "OAT JOHN A SMITH" and "John Smith" all count as the owner.
function isOwner(name, owners) {
  var n = nameTokens_(name);
  if (!n.length) return false;
  return (owners || []).some(function (o) {
    var t = nameTokens_(o);
    if (!t.length) return false;
    return n.indexOf(t[0]) >= 0 && n.indexOf(t[t.length - 1]) >= 0;
  });
}

function parseMessage(text, sender, owners) {
  var t = squash_(text), m;
  if (!t) return { ignore: 'empty' };
  if (/\bOTP\b|one[- ]time password|verification code|passcode|activation code/i.test(t)) return { ignore: 'one-time password' };
  if (/declin|not approved|unsuccessful|was rejected|could not be processed|insufficient/i.test(t)) return { ignore: 'declined' };
  var bank = detectBank(sender, t);
  var bal = findBalance(t);
  var CUR = '(' + CURRENCIES + ')';
  var AMT = '([\\d,]+(?:\\.\\d+)?)';
  function out(o) {
    o.bank = o.bank || bank;
    o.balance = o.balance === undefined ? bal : o.balance;
    o.currency = (o.currency || 'AED').toUpperCase();
    o.party = o.party ? title_(o.party) : '';
    if (o.party && isOwner(o.party, owners) && (o.kind === 'transfer' || o.kind === 'account')) o.type = 'Own';
    return o;
  }

  // Bank confirms that money reached the owner's other account (e.g. ADCB about Al Hilal).
  if ((m = t.match(new RegExp('Confirmation rec(?:eive)?d\\.? from (.+?): ' + CUR + ' ?' + AMT + ' transferred on .+? to (.+?) has been credited', 'i')))) {
    return out({ type: 'Info', flow: 'in', kind: 'confirm', currency: m[2], amount: num_(m[3]),
      party: m[4], toOwner: isOwner(m[4], owners), balance: '' });
  }

  // Credit card bill paid: "your payment of AED500.00 on 01/01/2026 for card ending with *1234 has been credited."
  if ((m = t.match(new RegExp('payment of ' + CUR + ' ?' + AMT + '.{0,40}?for (?:your )?(?:credit )?card ending (?:with )?[*xX]*(\\d{3,4}).{0,20}?(?:has been |was )?(?:credited|received)', 'i')))) {
    return out({ type: 'Info', flow: 'in', kind: 'confirm', currency: m[1], amount: num_(m[2]), account: '*' + m[3],
      party: 'Card payment', toOwner: true, balance: '' });
  }

  // Card purchase: "Trx. of AED33.25 on your card ending *1234 at Emirates Post, UAE is Approved."
  // "Transaction of AED 14.70 debited from your a/c *4321 at NABRAS ... AE. Avl Bal is AED 27.40"
  if ((m = t.match(new RegExp('(?:Trx\\.?|Transaction|Purchase|Payment)\\s+of\\s+' + CUR + '\\s?' + AMT +
      '\\s+(?:on|from|debited from|made on|made with|using|with)\\s+your\\s+(?:credit |debit |covered |prepaid )?(?:card|a\\/c|account)\\s*(?:no\\.?\\s*)?(?:ending(?: with)?\\s*)?[*xX]*(\\d{3,4})\\s+at\\s+(.+?)(?=\\s+is approved|\\s+on \\d|\\.\\s+(?:Avl|Av\\b|Available|Your|Trx)|\\.?$)', 'i')))) {
    var refund = /refund|reversal|credited/i.test(t.slice(0, 60));
    return out({ type: refund ? 'In' : 'Out', flow: refund ? 'in' : 'out', kind: refund ? 'refund' : 'purchase',
      currency: m[1], amount: num_(m[2]), account: '*' + m[3], party: m[4] });
  }

  // Looser purchase wording used by other banks: "Purchase of AED 25.00 with Debit Card ending 1234 at CARREFOUR on ..."
  if ((m = t.match(new RegExp('(?:purchase|spent|payment|trx\\.?|transaction)\\b.{0,40}?' + CUR + '\\s?' + AMT +
      '.{0,60}?(?:card|a\\/c|account)\\D{0,25}(\\d{3,4}).{0,30}?\\bat\\s+(.+?)(?=\\s+on\\s+\\d|\\s+is approved|\\.\\s|,\\s*(?:avl|available)|\\.?$)', 'i'))) &&
      !/credited/i.test(t)) {
    return out({ type: 'Out', flow: 'out', kind: 'purchase', currency: m[1], amount: num_(m[2]), account: '*' + m[3], party: m[4] });
  }

  // Al Hilal: "Transfer of 340.00 AED to Omar Khalid from account ending with 5678. New balance: ..."
  if ((m = t.match(new RegExp('Transfer of ' + AMT + ' ?' + CUR + ' to (.+?) from (?:your )?account ending (?:with )?(\\d+)', 'i')))) {
    return out({ type: 'Out', flow: 'out', kind: 'transfer', currency: m[2], amount: num_(m[1]), party: m[3], account: '*' + m[4] });
  }

  // Al Hilal: "15000.00 AED credited to account ending with 5678 for WPS Transfers, Salary Jul2025. Balance: ..."
  if ((m = t.match(new RegExp(AMT + ' ?' + CUR + ' credited to (?:your )?account ending (?:with )?(\\d+) for (.+?)(?=\\.\\s*(?:Balance|Avl|Available|New balance)|$)', 'i')))) {
    var purpose = m[4], party = '', kind = 'transfer', p;
    if (/WPS|salary|payroll/i.test(purpose)) { kind = 'salary'; party = (purpose.match(/salary[^,.]*/i) || ['Salary'])[0]; }
    else if ((p = purpose.match(/From:\s*(.+)$/i)) || (p = purpose.match(/\bOAT\s+(.+)$/i))) party = personName_(p[1]);
    else if (/refund|reversal/i.test(purpose)) { kind = 'refund'; party = purpose; }
    else party = /transfer|aani|ipp|remittance/i.test(purpose) ? personName_(purpose) : purpose;
    return out({ type: 'In', flow: 'in', kind: kind, currency: m[2], amount: num_(m[1]), party: party, account: '*' + m[3] });
  }

  // ADCB: "AED67.00 transferred via ADCB Personal Internet Banking / Mobile App from acc. no. XXX810001 on ..."
  if ((m = t.match(new RegExp(CUR + ' ?' + AMT + ' transferred (?:via .+? )?from acc(?:ount)?\\.? ?(?:no\\.?)? ?[xX*]*(\\d+)', 'i')))) {
    var to = t.match(/\bto ([A-Z][A-Za-z .'-]{2,40}?)(?= on | from |\.|$)/);
    return out({ type: 'Out', flow: 'out', kind: 'transfer', currency: m[1], amount: num_(m[2]),
      account: '*' + m[3].slice(-4), party: to ? to[1] : '' });
  }

  // ADCB: "A Cr. transaction of AED 130.00 on your account number XXX810001 was successful."
  if ((m = t.match(new RegExp('A (Cr|Dr)\\.? transaction of ' + CUR + ' ?' + AMT + ' on your (?:account|card)(?: number| no\\.?)? ?[xX*]*(\\d+)', 'i')))) {
    var cr = /cr/i.test(m[1]);
    return out({ type: cr ? 'In' : 'Out', flow: cr ? 'in' : 'out', kind: 'account', currency: m[2], amount: num_(m[3]), account: '*' + m[4].slice(-4) });
  }

  // ADIB and others: "Dear Customer, AED 6000.00 was credited to your account *4321."
  if ((m = t.match(new RegExp(CUR + ' ?' + AMT + ' (?:was|has been|is) (debited|credited|withdrawn|deposited|transferred)\\s+(?:from|to|in|into)\\s+your\\s+(?:account|a\\/c|card)\\s*(?:no\\.?|number)?\\s*[*xX]*(\\d+)', 'i')))) {
    var inn = /credited|deposited/i.test(m[3]);
    var k = /withdrawn/i.test(m[3]) || /ATM/i.test(t) ? 'cash' : 'account';
    return out({ type: inn ? 'In' : 'Out', flow: inn ? 'in' : 'out', kind: k, currency: m[1], amount: num_(m[2]), account: '*' + m[4].slice(-4) });
  }

  // Fallback: any message with an amount and a clear direction word.
  var a = t.match(new RegExp(CUR + ' ?' + AMT)) || t.match(new RegExp(AMT + ' ?' + CUR));
  if (a) {
    var cur = /^[A-Z]{3}$/i.test(a[1]) ? a[1] : a[2], amt = /^[A-Z]{3}$/i.test(a[1]) ? a[2] : a[1];
    var isIn = /credited|received|deposit|refund|reversal|salary/i.test(t);
    var isOut = /debited|purchase|spent|paid|payment of|withdrawn|withdrawal|transferred|charged/i.test(t);
    if (isIn !== isOut) {
      var at = t.match(/\bat\s+([^.,]{3,40})/i);
      return out({ type: isIn ? 'In' : 'Out', flow: isIn ? 'in' : 'out',
        kind: /ATM|withdraw/i.test(t) ? 'cash' : (/refund|reversal/i.test(t) ? 'refund' : (/salary/i.test(t) ? 'salary' : 'account')),
        currency: cur, amount: num_(amt), party: at ? at[1] : '', check: true });
    }
    return { unknown: true, bank: bank };
  }
  return { ignore: 'no amount' };
}

// ----- categories -----
var DEFAULT_RULES = [
  ['Groceries', 'carrefour, lulu, spinneys, union coop, waitrose, choithrams, al maya, grandiose, abu dhabi coop, kibsons, viva, supermarket, hypermarket, baqala, grocery, nesto, west zone'],
  ['Food', 'restau, restaurant, cafeteria, mcdonald, kfc, burger, pizza, shawarma, talabat, deliveroo, noon food, careem food, bakery, grill, kitchen, eatery, sweets, juice, five guys, shake shack, nandos, hardees, subway, popeyes, al baik, mandi, biryani, food'],
  ['Coffee & tea', 'coffee, cafe, café, starbucks, costa, tim hortons, dunkin, karak, tea, espresso, arabica, caribou, pret, cafeteria karak'],
  ['Fuel', 'adnoc, enoc, eppco, emarat, petrol, fuel'],
  ['Transport', 'careem, uber, taxi, salik, darb, rta, parking, mawaqif, itc, bus, metro, hala, yango'],
  ['Bills & phone', 'etisalat, e& , du, virgin mobile, taqa, addc, aadc, sewa, dewa, fewa, empower, tabreed, zakhir, internet'],
  ['Shopping', 'noon, amazon, namshi, ikea, centrepoint, max fashion, h&m, zara, sharaf dg, virgin megastore, jumbo, shein, temu, mall, splash, home centre, ace hardware, dragon mart'],
  ['Health', 'pharmacy, aster, boots, clinic, hospital, medical, nmc, burjeel, cleveland, dental, optic'],
  ['Government & post', 'emirates post, icp, mohre, tamm, smart services, traffic, ministry, municipality, police, court, visa, ded'],
  ['Education', 'university, univer, school, college, academy, nursery, institute, course'],
  ['Subscriptions', 'netflix, spotify, apple.com, icloud, google, youtube, osn, shahid, anghami, openai, chatgpt, anthropic, claude, adobe, microsoft, disney'],
  ['Travel', 'emirates airline, etihad, flydubai, air arabia, booking.com, airbnb, hotel, agoda, expedia'],
  ['Entertainment', 'vox, cinema, novo, reel cinemas, ticketmaster, platinumlist, gaming, playstation, steam'],
  ['Charity', 'zakat, red crescent, charity, awqaf, donation']
];

function rulesFromTable(rows) {
  var list = [];
  (rows || []).forEach(function (r) {
    var cat = squash_(r[0]);
    if (!cat) return;
    String(r[1] || '').split(',').forEach(function (k) {
      k = squash_(k).toLowerCase();
      if (k) list.push([k, cat]);
    });
  });
  return list;
}

function escRe_(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function categorize(tx, rules) {
  if (tx.type === 'Own') return 'Between my accounts';
  if (tx.type === 'Info') return 'Bank confirmation';
  if (tx.kind === 'salary') return 'Salary';
  if (tx.kind === 'refund') return 'Refunds';
  var hay = (' ' + (tx.party || '') + ' ').toLowerCase();
  for (var i = 0; i < rules.length; i++) {
    var k = rules[i][0];
    var re = /^[a-z0-9 ]+$/.test(k) ? new RegExp('(^|[^a-z])' + escRe_(k) + '([^a-z]|$)') : null;
    if (re ? re.test(hay) : hay.indexOf(k) >= 0) return rules[i][1];
  }
  if (tx.kind === 'cash') return 'Cash';
  if (tx.kind === 'transfer') return tx.party ? (tx.type === 'In' ? 'From people' : 'To people') : 'Transfers';
  if (tx.type === 'Out' && !tx.party && tx.amount <= 10) return 'Bank fees';
  if (tx.type === 'In') return 'Money in';
  return 'Other';
}

// ----- matching against recent rows -----
// Returns what to do with a new transaction:
//   skip  - same message already saved, or a Wallet tap the SMS already covered
//   merge - an SMS that completes an earlier Wallet tap (fill bank, account, balance)
//   add   - a new row; ownWith lists rows to mark as "between my accounts"
function reconcile(nt, recent) {
  var MIN = 60000, HOUR = 3600000, i, r;
  function near(r, ms) { return Math.abs(r.time - nt.time) <= ms; }
  var res = { action: 'add', ownWith: [] };
  for (i = 0; i < recent.length; i++) {
    r = recent[i];
    if (nt.text && r.text === nt.text && near(r, 48 * HOUR)) return { action: 'skip', why: 'already saved' };
  }
  if (nt.type === 'Out' && nt.kind === 'purchase') {
    for (i = 0; i < recent.length; i++) {
      r = recent[i];
      if (r.type === 'Out' && r.kind === 'purchase' && r.amount === nt.amount && r.currency === nt.currency &&
          near(r, 20 * MIN) && (r.source === 'wallet') !== (nt.source === 'wallet') && !r.merged) {
        if (nt.source === 'wallet') return { action: 'skip', why: 'SMS already has this payment', id: r.id };
        return { action: 'merge', id: r.id };
      }
    }
  }
  var unnamed = !nt.party && (nt.kind === 'transfer' || nt.kind === 'account');
  for (i = recent.length - 1; i >= 0; i--) { // newest first
    r = recent[i];
    if (r.pair || r.amount !== nt.amount || r.currency !== nt.currency || !near(r, 48 * HOUR)) continue;
    // A bank confirmation that money reached my own account matches an unnamed transfer out.
    if (nt.type === 'Info' && nt.toOwner && r.type === 'Out' && !r.party && (r.kind === 'transfer' || r.kind === 'account')) {
      res.ownWith.push(r.id); res.selfOwn = false; break;
    }
    if (unnamed && nt.type === 'Out' && r.type === 'Info' && r.toOwner) {
      res.ownWith.push(r.id); res.selfOwn = true; break;
    }
    // A named transfer to/from myself matches the unnamed other side at my other bank.
    if (nt.type === 'Own' && r.flow !== nt.flow && !r.party && (r.kind === 'transfer' || r.kind === 'account') && r.type !== 'Info') {
      res.ownWith.push(r.id); res.markOther = true; break;
    }
    if (unnamed && r.type === 'Own' && r.flow !== nt.flow) {
      res.ownWith.push(r.id); res.selfOwn = true; break;
    }
  }
  return res;
}


// ===================== Google Sheet side =====================
var TZ = 'Asia/Dubai'; // your time zone (IANA name), e.g. 'Asia/Riyadh', 'Europe/London'
var SHEET_TX = 'Transactions', SHEET_CAT = 'Categories', SHEET_SET = 'Settings', SHEET_REV = 'Review';
var HEAD = ['ID', 'Time', 'Type', 'Flow', 'Amount', 'Currency', 'Bank', 'Account', 'Party', 'Category', 'Balance', 'Source', 'Kind', 'Pair', 'Text', 'Lat', 'Lng'];
var COL = {}; HEAD.forEach(function (h, i) { COL[h] = i; });

// Run this once from the editor (select "setup", press Run).
function setup() {
  if (!KEY || /^CHANGE-ME/.test(KEY) || KEY.length < 12) throw new Error('Set KEY at the top of Code.gs to a long random secret (12+ characters) before running setup.');
  var ss = ss_();
  var key = KEY;

  var tx = ss.getSheetByName(SHEET_TX) || ss.insertSheet(SHEET_TX);
  if (tx.getLastRow() === 0) {
    tx.appendRow(HEAD);
    tx.setFrozenRows(1);
    tx.getRange('B:B').setNumberFormat('yyyy-mm-dd hh:mm');
    tx.getRange('E:E').setNumberFormat('#,##0.00');
    tx.getRange('K:K').setNumberFormat('#,##0.00');
  }
  var cat = ss.getSheetByName(SHEET_CAT) || ss.insertSheet(SHEET_CAT);
  if (cat.getLastRow() === 0) {
    cat.appendRow(['Category', 'Words in the merchant name (comma separated)']);
    cat.getRange(2, 1, DEFAULT_RULES.length, 2).setValues(DEFAULT_RULES);
    cat.setFrozenRows(1); cat.setColumnWidth(2, 600);
  }
  var set = ss.getSheetByName(SHEET_SET);
  if (!set) {
    set = ss.insertSheet(SHEET_SET);
    set.getRange(1, 1, 3, 2).setValues([['Secret key (used in your Shortcuts and dashboard link)', key],
      ['My names as banks write them (comma separated)', 'YOUR NAME AS YOUR BANK WRITES IT'], ['Home currency', 'AED']]);
  }
  var rev = ss.getSheetByName(SHEET_REV) || ss.insertSheet(SHEET_REV);
  if (rev.getLastRow() === 0) rev.appendRow(['Time', 'Sender', 'Message (not understood, check and add by hand)']);
  var s1 = ss.getSheetByName('Sheet1'); if (s1 && ss.getSheets().length > 1 && s1.getLastRow() === 0) ss.deleteSheet(s1);
  Logger.log('Your secret key: ' + key);
  return key;
}

function ss_() { return SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet(); }
function key_() { return KEY; }
function owners_() {
  var v = ss_().getSheetByName(SHEET_SET).getRange('B2').getValue();
  return String(v || '').split(',').map(function (s) { return s.trim(); }).filter(String);
}
function rules_() {
  var sh = ss_().getSheetByName(SHEET_CAT);
  var n = sh.getLastRow();
  return rulesFromTable(n > 1 ? sh.getRange(2, 1, n - 1, 2).getValues() : DEFAULT_RULES);
}
// Credit cards from Settings: "*1234: 10000, *5678: 5000" -> { '1234': 10000, '5678': 5000 }
function cards_() {
  var set = ss_().getSheetByName(SHEET_SET), n = set.getLastRow(), out = {};
  if (n < 1) return out;
  set.getRange(1, 1, n, 2).getValues().forEach(function (r) {
    if (!/^credit cards/i.test(String(r[0]))) return;
    String(r[1]).split(',').forEach(function (p) {
      var m = p.match(/(\d{3,4})\s*[:=]\s*([\d,.]+)/);
      if (m) out[m[1]] = parseFloat(m[2].replace(/,/g, ''));
    });
  });
  return out;
}
function cardLimit_(cards, account) {
  var d = String(account || '').replace(/\D/g, '');
  for (var k in cards) if (d && (d === k || d.slice(-k.length) === k)) return cards[k];
  return 0;
}

// One-time update of the Categories and Settings tabs when the script gets new defaults.
// Words you added yourself (for example through "Always use this category") are kept.
var RULES_VERSION = '2';
// One-time tidy of names on money from people already saved (re-reads the original SMS).
var PEOPLE_VERSION = '1';
function peopleOnce_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('PEOPLE_V') === PEOPLE_VERSION) return;
  var sh = ss_().getSheetByName(SHEET_TX), own = owners_();
  readRows_(sh).forEach(function (r) {
    if (r.source.indexOf('sms') < 0 || !r.text || (r.kind !== 'transfer' && r.kind !== 'account')) return;
    var t = parseMessage(r.text, r.bank, own);
    if (t.party && t.party !== r.party) sh.getRange(r.row, COL.Party + 1).setValue(t.party);
  });
  props.setProperty('PEOPLE_V', PEOPLE_VERSION);
}
function upgrade_() {
  try { peopleOnce_(); } catch (e) { console.error(e); }
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('RULES_V') === RULES_VERSION) return;
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (props.getProperty('RULES_V') === RULES_VERSION) return;
    var ss = ss_(), cs = ss.getSheetByName(SHEET_CAT);
    var n = cs.getLastRow() - 1;
    var old = n > 0 ? cs.getRange(2, 1, n, 2).getValues() : [];
    var known = {};
    DEFAULT_RULES.forEach(function (r) { r[1].split(',').forEach(function (w) { known[squash_(w).toLowerCase()] = 1; }); });
    var rows = DEFAULT_RULES.map(function (r) { return [r[0], r[1]]; });
    old.forEach(function (r) {
      var cat = squash_(r[0]); if (!cat) return;
      var extra = String(r[1] || '').split(',').map(function (w) { return squash_(w).toLowerCase(); })
        .filter(function (w) { return w && !known[w]; });
      if (!extra.length) return;
      var target = cat === 'Food & coffee' ? 'Food' : cat;
      var row = rows.filter(function (x) { return x[0] === target; })[0];
      if (row) row[1] += ', ' + extra.join(', '); else rows.push([target, extra.join(', ')]);
    });
    if (n > 0) cs.getRange(2, 1, n, 2).clearContent();
    cs.getRange(2, 1, rows.length, 2).setValues(rows);
    var set = ss.getSheetByName(SHEET_SET);
    var labels = set.getRange(1, 1, Math.max(1, set.getLastRow()), 1).getValues().map(function (v) { return String(v[0]); });
    if (!labels.some(function (l) { return /^credit cards/i.test(l); })) {
      set.appendRow(['Credit cards (card ending: limit, comma separated)', '']);
    }
    // Earlier rows saved as "Food & coffee" keep working under the new names.
    var tx = ss.getSheetByName(SHEET_TX), tn = tx.getLastRow() - 1;
    if (tn > 0) {
      var cr = tx.getRange(2, COL.Category + 1, tn, 1), cv = cr.getValues();
      cv.forEach(function (v) { if (v[0] === 'Food & coffee') v[0] = 'Food'; if (v[0] === 'Transfers out') v[0] = 'To people'; if (v[0] === 'Transfers in') v[0] = 'From people'; });
      cr.setValues(cv);
    }
    props.setProperty('RULES_V', RULES_VERSION);
  } finally { lock.releaseLock(); }
}

// Usual payday (day of month) from Settings; the row is added the first time it is needed.
function payday_() {
  var set = ss_().getSheetByName(SHEET_SET), n = set.getLastRow();
  var vals = n ? set.getRange(1, 1, n, 2).getValues() : [];
  for (var i = 0; i < vals.length; i++) if (/^usual payday/i.test(String(vals[i][0]))) {
    var d = parseInt(vals[i][1], 10); return d >= 1 && d <= 28 ? d : 24;
  }
  set.appendRow(['Usual payday (day of month, used to guess the next salary)', 24]);
  return 24;
}

function keyToUTC_(k) { var p = k.split('-'); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }

// Salary-to-salary: from the day the last salary landed to the expected next one.
function period_(rows) {
  var pd = payday_(), sal = null;
  rows.forEach(function (r) { if (r.type === 'In' && r.category === 'Salary' && r.currency === 'AED' && (!sal || r.time > sal.time)) sal = r; });
  if (!sal) return { none: true, payday: pd };
  var start = dayKey_(sal.time), today = dayKey_(Date.now());
  var p = start.split('-'), y = +p[0], m = +p[1], d = +p[2];
  var nx = new Date(Date.UTC(y, (d >= 10 ? m : m - 1), pd));
  if (nx.getTime() <= keyToUTC_(start)) nx = new Date(Date.UTC(y, m, pd));
  var next = nx.toISOString().slice(0, 10);
  var salary = 0, spent = 0, otherIn = 0, n = 0;
  rows.forEach(function (r) {
    if (r.currency !== 'AED') return;
    var k = dayKey_(r.time); if (k < start) return;
    if (r.type === 'In' && r.category === 'Salary') salary += r.amount;
    else if (r.type === 'In') otherIn += r.amount;
    else if (r.type === 'Out') { spent += r.amount; n++; }
  });
  var daysLeft = Math.max(0, Math.round((keyToUTC_(next) - keyToUTC_(today)) / 86400000));
  var daysIn = Math.round((keyToUTC_(today) - keyToUTC_(start)) / 86400000) + 1;
  var left = salary - spent;
  return { start: start, next: next, today: today, salary: salary, spent: spent, left: left, otherIn: otherIn, payments: n,
    daysLeft: daysLeft, daysIn: daysIn, perDay: daysLeft > 0 ? left / daysLeft : left, party: sal.party };
}

function text_(s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT); }
function fmt_(n) { return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!p.key || p.key !== key_()) return text_('Not allowed. Add ?key=YOUR_KEY to the link.');
  upgrade_();
  try { overviewOnce_(); } catch (err) { console.error(err); }
  if (p.action === 'summary') return text_(dailySummary_());
  if (p.action === 'add') return text_(ingest_(p));
  var t = HtmlService.createTemplateFromFile('Dashboard');
  t.key = p.key;
  return t.evaluate().setTitle('My Money')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { body = (e && e.parameter) || {}; }
  if (!body.key || body.key !== key_()) return text_('Not allowed');
  upgrade_();
  return text_(ingest_(body));
}

function readRows_(sh, last) {
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  var start = last ? Math.max(2, sh.getLastRow() - last + 1) : 2;
  var vals = sh.getRange(start, 1, sh.getLastRow() - start + 1, HEAD.length).getValues();
  var own = owners_();
  return vals.map(function (v, i) {
    return { row: start + i, id: String(v[0]), time: v[1] instanceof Date ? v[1].getTime() : new Date(v[1]).getTime(),
      type: v[2], flow: v[3], amount: Number(v[4]), currency: v[5], bank: v[6], account: v[7], party: v[8],
      category: v[9], balance: v[10], source: v[11], kind: v[12], pair: String(v[13] || ''), text: v[14],
      toOwner: v[2] === 'Info' && (isOwner(v[8], own) || v[8] === 'Card Payment'), merged: /\+/.test(v[11]),
      lat: v[15] === '' ? '' : Number(v[15]), lng: v[16] === '' ? '' : Number(v[16]) };
  });
}

function toRow_(t) {
  return [t.id, new Date(t.time), t.type, t.flow, t.amount, t.currency, t.bank, t.account || '', t.party || '',
    t.category, t.balance === '' ? '' : t.balance, t.source, t.kind, t.pair || '', t.text || '',
    t.lat === undefined ? '' : t.lat, t.lng === undefined ? '' : t.lng];
}

// Takes one SMS, Wallet tap or manual entry and saves it.
function headers_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('HEAD_V') === '2') return;
  ss_().getSheetByName(SHEET_TX).getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold');
  props.setProperty('HEAD_V', '2');
}

function ingest_(b) {
  headers_();
  var src = String(b.source || 'sms').toLowerCase();
  var tx;
  if (src === 'wallet') {
    var amt = String(b.amount || '').match(/[\d,]+(?:\.\d+)?/);
    if (!amt) return 'Skipped: no amount from Wallet';
    var cur = String(b.amount).match(new RegExp(CURRENCIES));
    var card = String(b.card || '').trim();
    tx = { type: 'Out', flow: 'out', kind: 'purchase', amount: Math.round(parseFloat(amt[0].replace(/,/g, '')) * 100) / 100,
      currency: cur ? cur[0] : 'AED', bank: detectBank(card, card), account: card, party: title_(b.merchant || ''), balance: '' };
    var ll = String(b.lat || '') + ',' + String(b.lng || '') + ',' + String(b.location || '');
    var nums = ll.match(/-?\d+\.\d+/g);
    if (nums && nums.length >= 2) { tx.lat = parseFloat(nums[0]); tx.lng = parseFloat(nums[1]); }
  } else if (src === 'manual') {
    tx = { type: b.type === 'In' ? 'In' : 'Out', flow: b.type === 'In' ? 'in' : 'out', kind: 'manual',
      amount: Math.round(parseFloat(b.amount) * 100) / 100, currency: 'AED', bank: b.bank || 'Cash', account: '',
      party: title_(b.party || ''), balance: '', category: b.category || '' };
    if (!(tx.amount > 0)) return 'Skipped: amount missing';
  } else {
    tx = parseMessage(b.text, b.sender, owners_());
    if (tx.ignore) return 'Ignored: ' + tx.ignore;
    if (tx.unknown) {
      ss_().getSheetByName(SHEET_REV).appendRow([new Date(), b.sender || '', String(b.text || '')]);
      return 'Saved for review: not understood';
    }
    tx.text = squash_(b.text);
  }
  // "as=own" marks a transfer between my own accounts (used for links I tap by hand).
  if (String(b.as || '').toLowerCase() === 'own' && tx.type !== 'Info') { tx.type = 'Own'; tx.category = 'Between my accounts'; }
  tx.source = src;
  tx.time = Date.now();
  tx.id = Utilities.getUuid().slice(0, 8);

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = ss_().getSheetByName(SHEET_TX);
    var recent = readRows_(sh, 300);
    var d = reconcile(tx, recent);
    if (d.action === 'skip') {
      if (d.id && tx.lat !== undefined) {
        var hit = recent.filter(function (r) { return r.id === d.id; })[0];
        if (hit && hit.lat === '') { sh.getRange(hit.row, 16, 1, 2).setValues([[tx.lat, tx.lng]]); return 'Added location to the SMS payment'; }
      }
      return 'Skipped: ' + d.why;
    }
    var byId = {}; recent.forEach(function (r) { byId[r.id] = r; });
    if (d.action === 'merge') {
      var w = byId[d.id];
      var vals = [w.id, new Date(w.time), w.type, w.flow, w.amount, w.currency, tx.bank, tx.account || w.account,
        w.party || tx.party, w.category, tx.balance, 'wallet+sms', w.kind, w.pair, tx.text, w.lat, w.lng];
      sh.getRange(w.row, 1, 1, HEAD.length).setValues([vals]);
      return 'Matched with Wallet: ' + tx.currency + ' ' + fmt_(tx.amount) + ' ' + (w.party || tx.party);
    }
    if (d.selfOwn && tx.type !== 'Info') tx.type = 'Own';
    if (d.ownWith.length) {
      tx.pair = d.ownWith[0];
      d.ownWith.forEach(function (oid) {
        var r = byId[oid]; if (!r) return;
        if (r.type !== 'Info') { sh.getRange(r.row, COL.Type + 1).setValue('Own'); sh.getRange(r.row, COL.Category + 1).setValue('Between my accounts'); }
        sh.getRange(r.row, COL.Pair + 1).setValue(tx.id);
      });
    }
    if (!tx.category || tx.category === 'Between my accounts' && tx.type !== 'Own') tx.category = categorize(tx, rules_());
    if (tx.type === 'Own') tx.category = 'Between my accounts';
    sh.appendRow(toRow_(tx));
    return 'Saved: ' + tx.type + ' ' + tx.currency + ' ' + fmt_(tx.amount) + (tx.party ? ' · ' + tx.party : '') + ' · ' + tx.category;
  } finally {
    lock.releaseLock();
  }
}

function dayKey_(ms) { return Utilities.formatDate(new Date(ms), TZ, 'yyyy-MM-dd'); }

function dailySummary_() {
  var rows = readRows_(ss_().getSheetByName(SHEET_TX), 800);
  var today = dayKey_(Date.now()), month = today.slice(0, 7);
  var tOut = 0, tIn = 0, nOut = 0, nIn = 0, mOut = 0, mIn = 0, cats = {}, other = 0;
  rows.forEach(function (r) {
    if (r.type !== 'Out' && r.type !== 'In') return;
    var dk = dayKey_(r.time);
    if (r.currency !== 'AED') { if (dk === today) other++; return; }
    if (dk.slice(0, 7) === month) { if (r.type === 'Out') mOut += r.amount; else mIn += r.amount; }
    if (dk !== today) return;
    if (r.type === 'Out') { tOut += r.amount; nOut++; cats[r.category] = (cats[r.category] || 0) + r.amount; }
    else { tIn += r.amount; nIn++; }
  });
  var label = Utilities.formatDate(new Date(), TZ, 'EEE d MMM');
  var lines = [];
  if (!nOut && !nIn) lines.push(label + ': nothing recorded today.');
  else {
    lines.push(label + ': spent AED ' + fmt_(tOut) + ' (' + nOut + ')' + (nIn ? ', received AED ' + fmt_(tIn) + ' (' + nIn + ')' : ''));
    var top = Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; }).slice(0, 3);
    if (top.length) lines.push('Top: ' + top.map(function (c) { return c + ' ' + fmt_(cats[c]); }).join(', '));
  }
  if (other) lines.push(other + ' payment(s) in another currency, not in totals.');
  lines.push(Utilities.formatDate(new Date(), TZ, 'MMMM') + ' so far: spent AED ' + fmt_(mOut) + ', received AED ' + fmt_(mIn));
  var per = period_(rows);
  if (!per.none) lines.push(per.daysLeft > 0 ?
    'Since payday: spent AED ' + fmt_(per.spent) + ' of ' + fmt_(per.salary) + ' · AED ' + fmt_(Math.max(0, per.perDay)) + '/day for ' + per.daysLeft + ' days' :
    'Since payday: spent AED ' + fmt_(per.spent) + ' of ' + fmt_(per.salary) + ' · salary due any day');
  var cards = cards_(), seen = {};
  for (var i = rows.length - 1; i >= 0; i--) {
    var r = rows[i], lim = cardLimit_(cards, r.account);
    if (!lim || seen[r.account] || r.balance === '' || r.balance === null || r.type === 'Info') continue;
    seen[r.account] = 1;
    lines.push('Card ' + r.account + ': used AED ' + fmt_(lim - Number(r.balance)) + ' of ' + fmt_(lim));
  }
  var rev = ss_().getSheetByName(SHEET_REV).getLastRow() - 1;
  if (rev > 0) lines.push(rev + ' message(s) waiting in the Review tab.');
  return lines.join('\n');
}

// ----- called by the dashboard page -----
function getData(key, month) {
  if (key !== key_()) throw new Error('Not allowed');
  upgrade_();
  headers_();
  var rows = readRows_(ss_().getSheetByName(SHEET_TX));
  var months = {}, balances = {}, list = [], totals = {};
  var cards = cards_();
  month = month || dayKey_(Date.now()).slice(0, 7);
  rows.forEach(function (r) {
    var dk = dayKey_(r.time), mk = dk.slice(0, 7);
    months[mk] = 1;
    if ((r.type === 'In' || r.type === 'Out') && r.currency === 'AED') {
      totals[mk] = totals[mk] || { 'in': 0, out: 0 };
      totals[mk][r.type === 'In' ? 'in' : 'out'] += r.amount;
    }
    if (r.balance !== '' && r.balance !== null && r.type !== 'Info') {
      var ak = r.bank + ' ' + (r.account || '');
      if (!balances[ak] || balances[ak].time < r.time) balances[ak] = { bank: r.bank, account: r.account, balance: Number(r.balance), time: r.time, when: Utilities.formatDate(new Date(r.time), TZ, 'd MMM, HH:mm') };
    }
    if (mk === month && r.type !== 'Info') {
      list.push({ id: r.id, flow: r.flow, day: dk, ts: r.time, lat: r.lat, lng: r.lng, hm: Utilities.formatDate(new Date(r.time), TZ, 'HH:mm'), type: r.type, amount: r.amount,
        currency: r.currency, bank: r.bank, account: r.account, party: r.party, category: r.category, source: r.source });
    }
  });
  var cats = ss_().getSheetByName(SHEET_CAT).getRange('A2:A').getValues().map(function (v) { return v[0]; }).filter(String);
  ['Salary', 'From people', 'To people', 'Money in', 'Refunds', 'Cash', 'Bank fees', 'Between my accounts', 'Transfers', 'Other']
    .forEach(function (c) { if (cats.indexOf(c) < 0) cats.push(c); });
  var trend = [], p = month.split('-'), y = +p[0], mo = +p[1];
  for (var i = 5; i >= 0; i--) {
    var d = new Date(y, mo - 1 - i, 1), k = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
    trend.push({ month: k, 'in': totals[k] ? totals[k]['in'] : 0, out: totals[k] ? totals[k].out : 0 });
  }
  var all = Object.keys(balances).map(function (k) { return balances[k]; }).sort(function (a, b) { return b.time - a.time; });
  var cardList = [], accts = [];
  all.forEach(function (b) {
    var lim = cardLimit_(cards, b.account);
    if (lim) cardList.push({ bank: b.bank, account: b.account, limit: lim, available: b.balance, used: Math.max(0, lim - b.balance), when: b.when });
    else accts.push(b);
  });
  return { month: month, today: dayKey_(Date.now()), months: Object.keys(months).sort(), rows: list.reverse(),
    trend: trend, cards: cardList, balances: accts, period: period_(rows), budgets: budgets_(), streak: streak_(rows),
    categories: cats, review: Math.max(0, ss_().getSheetByName(SHEET_REV).getLastRow() - 1) };
}

// Change a category, or mark a row as between my accounts / ignored. Optionally teach the rule.
function updateTx(key, id, change) {
  if (key !== key_()) throw new Error('Not allowed');
  var sh = ss_().getSheetByName(SHEET_TX);
  var rows = readRows_(sh);
  var r = rows.filter(function (x) { return x.id === id; })[0];
  if (!r) throw new Error('Row not found');
  if (change.remove) { sh.deleteRow(r.row); return 'Removed'; }
  if (change.type) sh.getRange(r.row, COL.Type + 1).setValue(change.type);
  if (change.category) sh.getRange(r.row, COL.Category + 1).setValue(change.category);
  if (change.type === 'Own') sh.getRange(r.row, COL.Category + 1).setValue('Between my accounts');
  if (change.learn && change.category && r.party) {
    var word = squash_(r.party).toLowerCase().split(/\s+/).slice(0, 2).join(' ');
    var cs = ss_().getSheetByName(SHEET_CAT);
    var vals = cs.getRange(2, 1, Math.max(1, cs.getLastRow() - 1), 2).getValues();
    var i = vals.map(function (v) { return v[0]; }).indexOf(change.category);
    if (i >= 0) cs.getRange(i + 2, 2).setValue(vals[i][1] + ', ' + word);
    else cs.appendRow([change.category, word]);
  }
  return 'Updated';
}

function addManual(key, entry) {
  if (key !== key_()) throw new Error('Not allowed');
  entry.source = 'manual';
  return ingest_(entry);
}

// ===================== Overview tab =====================
// Summary tables built from formulas (they update by themselves as rows arrive) plus charts.
var OVERVIEW_VERSION = '1';
function overviewOnce_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('OVERVIEW_V') === OVERVIEW_VERSION) return;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    if (props.getProperty('OVERVIEW_V') === OVERVIEW_VERSION) return;
    buildOverview();
    props.setProperty('OVERVIEW_V', OVERVIEW_VERSION);
  } finally { lock.releaseLock(); }
}

// Can also be run by hand from the editor to rebuild the tab.
function buildOverview() {
  var ss = ss_();
  ss.setSpreadsheetTimeZone(TZ);
  ss.getSheetByName(SHEET_TX).getRange('B:B').setNumberFormat('yyyy-mm-dd HH:mm');
  var sh = ss.getSheetByName('Overview') || ss.insertSheet('Overview', 0);
  sh.getCharts().forEach(function (c) { sh.removeChart(c); });
  sh.clear();
  sh.setHiddenGridlines(true);
  var T = 'Transactions!';
  var OUT = T + '$C:$C,"Out",' + T + '$F:$F,"AED"', IN = T + '$C:$C,"In",' + T + '$F:$F,"AED"';
  var MS = 'EOMONTH(TODAY(),-1)+1', ME = 'EOMONTH(TODAY(),0)+1';
  function sumifs(kind, from, to) { return '=SUMIFS(' + T + '$E:$E,' + kind + ',' + T + '$B:$B,">="&' + from + ',' + T + '$B:$B,"<"&' + to + ')'; }

  sh.getRange('A1').setValue('My Money overview').setFontSize(18).setFontWeight('bold');
  sh.getRange('A2').setValue('Updates by itself as transactions arrive. Amounts in AED; transfers between your own accounts are left out.').setFontColor('#5D6B63');

  // Key figures
  var k = [
    ['This month', ''],
    ['Spent', sumifs(OUT, MS, ME)],
    ['Received', sumifs(IN, MS, ME)],
    ['Net', '=B6-B5'],
    ['Spent today', sumifs(OUT, 'TODAY()', 'TODAY()+1')],
    ['Payments this month', '=COUNTIFS(' + OUT + ',' + T + '$B:$B,">="&' + MS + ',' + T + '$B:$B,"<"&' + ME + ')']
  ];
  sh.getRange(4, 1, k.length, 2).setValues(k);
  sh.getRange('A4').setFontWeight('bold');
  var row = 4 + k.length;
  var cards = cards_();
  Object.keys(cards).forEach(function (c) {
    var avail = '=IFERROR(ARRAYFORMULA(LOOKUP(2,1/((' + T + '$H$2:$H="*' + c + '")*(' + T + '$K$2:$K<>"")),' + T + '$K$2:$K)),' + cards[c] + ')';
    sh.getRange(row, 1, 3, 2).setValues([
      ['Card *' + c + ' available', avail],
      ['Card *' + c + ' used', '=' + cards[c] + '-B' + row],
      ['Card *' + c + ' limit', cards[c]]]);
    row += 3;
  });
  sh.getRange(5, 2, row - 5, 1).setNumberFormat('#,##0.00');
  sh.getRange(9, 2).setNumberFormat('0');

  // Spending by category, this month
  var r1 = row + 2;
  sh.getRange(r1, 1).setValue('Spending by category, this month').setFontWeight('bold');
  sh.getRange(r1 + 1, 1).setFormula('=IFERROR(QUERY(Transactions!A:O,"select J, sum(E) where C = \'Out\' and F = \'AED\' and B >= datetime \'"&TEXT(' + MS + ',"yyyy-mm-dd")&" 00:00:00\' group by J order by sum(E) desc label J \'Category\', sum(E) \'Spent\'",1),"No spending yet this month")');
  sh.getRange(r1 + 2, 2, 20, 1).setNumberFormat('#,##0.00');

  // Top places and people, this month
  sh.getRange(r1, 4).setValue('Top places and people, this month').setFontWeight('bold');
  sh.getRange(r1 + 1, 4).setFormula('=IFERROR(QUERY(Transactions!A:O,"select I, count(E), sum(E) where C = \'Out\' and F = \'AED\' and I <> \'\' and B >= datetime \'"&TEXT(' + MS + ',"yyyy-mm-dd")&" 00:00:00\' group by I order by sum(E) desc limit 10 label I \'Where / who\', count(E) \'Times\', sum(E) \'Spent\'",1),"")');
  sh.getRange(r1 + 2, 6, 10, 1).setNumberFormat('#,##0.00');

  // Money in vs out, last 12 months
  var r2 = r1 + 24;
  sh.getRange(r2, 1).setValue('Money in vs out, last 12 months').setFontWeight('bold');
  var m = [['Month', 'Money in', 'Money out']];
  for (var i = 11; i >= 0; i--) {
    var st = 'EOMONTH(TODAY(),' + (-i - 1) + ')+1', en = 'EOMONTH(TODAY(),' + (-i) + ')+1';
    m.push(['=TEXT(' + st + ',"mmm yy")', sumifs(IN, st, en), sumifs(OUT, st, en)]);
  }
  sh.getRange(r2 + 1, 1, m.length, 3).setValues(m);
  sh.getRange(r2 + 2, 2, 12, 2).setNumberFormat('#,##0');

  // Spending per day, this month
  var r3 = r2 + 15;
  sh.getRange(r3, 1).setValue('Spending per day, this month').setFontWeight('bold');
  var dd = [['Day', 'Spent']];
  for (var d = 1; d <= 31; d++) {
    var ds = '(' + MS + '+' + (d - 1) + ')';
    dd.push(['=IF(' + ds + '<' + ME + ',' + d + ',"")', '=IF(' + ds + '<' + ME + ',' + sumifs(OUT, ds, ds + '+1').slice(1) + ',"")']);
  }
  sh.getRange(r3 + 1, 1, dd.length, 2).setValues(dd);
  sh.getRange(r3 + 2, 2, 31, 1).setNumberFormat('#,##0.00');

  // Look
  [4, r1, r2, r3].forEach(function (r) { sh.getRange(r, 1, 1, 6).setBorder(null, null, true, null, null, null, '#D5DCD2', SpreadsheetApp.BorderStyle.SOLID); });
  sh.setColumnWidth(1, 210); sh.setColumnWidth(2, 120); sh.setColumnWidth(3, 110); sh.setColumnWidth(4, 220); sh.setColumnWidth(5, 70); sh.setColumnWidth(6, 110);
  sh.getRange(r1 + 1, 1, 1, 6).setFontWeight('bold');
  sh.getRange(r2 + 1, 1, 1, 3).setFontWeight('bold');
  sh.getRange(r3 + 1, 1, 1, 2).setFontWeight('bold');

  // Charts, to the right of the tables
  var green = '#17784A', red = '#B23A41', blue = '#2347C9';
  function chart(type, range, title, colors, r, extra) {
    var b = sh.newChart().setChartType(type).addRange(range).setNumHeaders(1)
      .setPosition(r, 8, 0, 0).setOption('title', title).setOption('width', 620).setOption('height', 330)
      .setOption('legend', { position: 'bottom' }).setOption('colors', colors);
    if (extra) Object.keys(extra).forEach(function (o) { b.setOption(o, extra[o]); });
    sh.insertChart(b.build());
  }
  chart(Charts.ChartType.PIE, sh.getRange(r1 + 1, 1, 21, 2), 'Spending by category, this month',
    [blue, '#E0A443', '#D9483B', '#2F9E8F', '#C25AA0', '#3E7CC9', '#8A8F98', '#5FAE4E', '#B7795B', '#E04B5A'], 1, { pieHole: 0.45 });
  chart(Charts.ChartType.COLUMN, sh.getRange(r2 + 1, 1, 13, 3), 'Money in vs out, last 12 months', [green, red], 18);
  chart(Charts.ChartType.COLUMN, sh.getRange(r3 + 1, 1, 32, 2), 'Spending per day, this month', [blue], 35, { legend: { position: 'none' } });
  var bar = sh.newChart().setChartType(Charts.ChartType.BAR)
    .addRange(sh.getRange(r1 + 1, 4, 11, 1)).addRange(sh.getRange(r1 + 1, 6, 11, 1)).setNumHeaders(1)
    .setPosition(52, 8, 0, 0).setOption('title', 'Top places and people, this month').setOption('width', 620).setOption('height', 330)
    .setOption('legend', { position: 'none' }).setOption('colors', [blue]);
  sh.insertChart(bar.build());
  sh.setFrozenRows(2);
  return 'Overview built';
}

// ===================== Budgets and streaks =====================
function budgets_() {
  var sh = ss_().getSheetByName('Budgets'), out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
    var v = parseFloat(r[1]); if (r[0] && v > 0) out[String(r[0])] = v;
  });
  return out;
}

// Saves monthly budgets from the dashboard: { 'Food': 800, 'Fuel': 400 }. Empty or 0 removes a budget.
function setBudgets(key, map) {
  if (key !== key_()) throw new Error('Not allowed');
  var ss = ss_(), sh = ss.getSheetByName('Budgets') || ss.insertSheet('Budgets');
  sh.clear();
  var rows = [['Category', 'Monthly budget (AED)']];
  Object.keys(map || {}).forEach(function (c) { var v = parseFloat(map[c]); if (v > 0) rows.push([c, v]); });
  sh.getRange(1, 1, rows.length, 2).setValues(rows);
  sh.getRange(1, 1, 1, 2).setFontWeight('bold'); sh.setColumnWidth(1, 200); sh.setColumnWidth(2, 170);
  return rows.length - 1;
}

function streakLimit_() {
  var set = ss_().getSheetByName(SHEET_SET), n = set.getLastRow();
  var vals = n ? set.getRange(1, 1, n, 2).getValues() : [];
  for (var i = 0; i < vals.length; i++) if (/^no-spend streak/i.test(String(vals[i][0]))) return Math.max(0, parseFloat(vals[i][1]) || 0);
  set.appendRow(['No-spend streak limit (AED a day that still counts as a no-spend day)', 0]);
  return 0;
}

// Days in a row with spending at or under the limit, counted back from today.
function streak_(rows) {
  var limit = streakLimit_(), per = {}, first = null;
  rows.forEach(function (r) {
    var k = dayKey_(r.time);
    if (!first || k < first) first = k;
    if (r.type === 'Out' && r.currency === 'AED') per[k] = (per[k] || 0) + r.amount;
  });
  if (!first) return { current: 0, best: 0, limit: limit, todayOk: true, start: null };
  var today = dayKey_(Date.now()), t0 = keyToUTC_(first), t1 = keyToUTC_(today);
  var best = 0, run = 0, d, k;
  for (d = t0; d <= t1; d += 86400000) {
    k = new Date(d).toISOString().slice(0, 10);
    if ((per[k] || 0) <= limit) { run++; if (run > best) best = run; } else run = 0;
  }
  var cur = 0;
  for (d = t1; d >= t0; d -= 86400000) {
    k = new Date(d).toISOString().slice(0, 10);
    if ((per[k] || 0) <= limit) cur++; else break;
  }
  return { current: cur, best: best, limit: limit, todayOk: (per[today] || 0) <= limit, todaySpent: per[today] || 0, start: first };
}

// ===================== Monthly email report =====================
// Runs on the 1st of each month (after setupMonthlyReport) and emails last month's summary to the sheet owner.
function monthlyReport() {
  var now = new Date(), y = +Utilities.formatDate(now, TZ, 'yyyy'), m = +Utilities.formatDate(now, TZ, 'M');
  var prev = m === 1 ? (y - 1) + '-12' : y + '-' + ('0' + (m - 1)).slice(-2);
  return sendReport_(prev, false);
}

// Run once from the editor: creates the monthly trigger and emails a preview of this month so far.
function setupMonthlyReport() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'monthlyReport') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('monthlyReport').timeBased().onMonthDay(1).atHour(8).inTimezone(TZ).create();
  return sendReport_(dayKey_(Date.now()).slice(0, 7), true);
}

function shiftMonth_(mk, k) {
  var p = mk.split('-'), d = new Date(Date.UTC(+p[0], +p[1] - 1 + k, 1));
  return d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2);
}
function monthName_(mk) { var p = mk.split('-'); return Utilities.formatDate(new Date(Date.UTC(+p[0], +p[1] - 1, 15)), TZ, 'MMMM yyyy'); }
function esc_(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

// Figures for one month (AED only, own transfers left out).
function monthStats_(rows, mk) {
  var s = { out: 0, inn: 0, nOut: 0, cats: {}, places: {}, big: [], days: {}, salary: 0, people: 0 };
  rows.forEach(function (r) {
    if (r.currency !== 'AED' || dayKey_(r.time).slice(0, 7) !== mk) return;
    if (r.type === 'Out') {
      s.out += r.amount; s.nOut++;
      s.cats[r.category] = (s.cats[r.category] || 0) + r.amount;
      var pl = r.party || r.category;
      s.places[pl] = s.places[pl] || { v: 0, n: 0 }; s.places[pl].v += r.amount; s.places[pl].n++;
      s.days[dayKey_(r.time)] = (s.days[dayKey_(r.time)] || 0) + r.amount;
      s.big.push(r);
    }
    if (r.type === 'In') { s.inn += r.amount; if (r.category === 'Salary') s.salary += r.amount; if (r.category === 'From people') s.people += r.amount; }
  });
  s.big.sort(function (a, b) { return b.amount - a.amount; });
  return s;
}

function reportHtml_(mk, rows, preview) {
  var cur = monthStats_(rows, mk), last = monthStats_(rows, shiftMonth_(mk, -1)), budgets = budgets_();
  var p = mk.split('-'), daysInMonth = new Date(Date.UTC(+p[0], +p[1], 0)).getUTCDate();
  var today = dayKey_(Date.now()), counted = mk === today.slice(0, 7) ? +today.slice(8) : daysInMonth;
  var noSpend = 0; for (var d = 1; d <= counted; d++) if (!cur.days[mk + '-' + ('0' + d).slice(-2)]) noSpend++;
  var net = cur.inn - cur.out, ink = '#15231C', muted = '#5D6B63', line = '#D5DCD2', red = '#B23A41', green = '#17784A', blue = '#2347C9';
  var mono = "font-family:'DM Mono',Menlo,Consolas,monospace;";
  function n0(v) { return Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
  function change(a, b) {
    if (!b) return '';
    var pc = Math.round((a - b) / b * 100);
    return '<span style="color:' + (pc > 0 ? red : green) + ';font-size:13px">' + (pc > 0 ? '▲ ' : '▼ ') + Math.abs(pc) + '% vs ' + monthName_(shiftMonth_(mk, -1)).split(' ')[0] + '</span>';
  }
  function head(t) { return '<tr><td style="padding:26px 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:' + muted + ';font-weight:600">' + t + '</td></tr>'; }
  var h = '<div style="background:#EDF0EA;padding:24px 12px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:' + ink + '">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#FBFCFA;border:1px solid ' + line + ';border-radius:16px"><tr><td style="padding:24px 24px 28px">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0">';
  h += '<tr><td style="font-size:13px;color:' + muted + '">' + (preview ? 'Preview · ' + esc_(monthName_(mk)) + ' so far' : 'Monthly report · ' + esc_(monthName_(mk))) + '</td></tr>';
  h += '<tr><td style="padding-top:6px;font-size:13px;color:' + muted + '">Spent</td></tr>';
  h += '<tr><td style="font-size:38px;font-weight:600;' + mono + 'line-height:1.1">AED ' + fmt_(cur.out) + '</td></tr>';
  h += '<tr><td style="padding-top:4px">' + change(cur.out, last.out) + '</td></tr>';
  h += '<tr><td style="padding-top:18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>' +
    [['Money in', n0(cur.inn), green], ['Money out', n0(cur.out), red], ['Net', (net < 0 ? '−' : '+') + n0(Math.abs(net)), net < 0 ? red : green]].map(function (c) {
      return '<td width="33%" style="border-top:2px solid ' + c[2] + ';padding-top:6px;vertical-align:top"><div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:' + muted + '">' + c[0] + '</div><div style="font-size:17px;' + mono + 'color:' + (c[0] === 'Net' ? c[2] : ink) + '">' + c[1] + '</div></td>';
    }).join('<td width="8"></td>') + '</tr></table></td></tr>';
  var facts = [];
  if (cur.salary) facts.push('Salary AED ' + n0(cur.salary) + (cur.salary ? ' · kept ' + Math.max(0, Math.round((cur.salary - cur.out) / cur.salary * 100)) + '%' : ''));
  if (cur.people) facts.push('From people AED ' + n0(cur.people));
  facts.push(cur.nOut + ' payment' + (cur.nOut === 1 ? '' : 's') + ' · ' + noSpend + ' no-spend day' + (noSpend === 1 ? '' : 's') + ' of ' + counted);
  if (cur.nOut) facts.push('Average AED ' + n0(cur.out / counted) + ' a day');
  h += '<tr><td style="padding-top:14px;font-size:14px;color:' + muted + ';line-height:1.6">' + facts.map(esc_).join('<br>') + '</td></tr>';
  var ck = Object.keys(cur.cats).sort(function (a, b) { return cur.cats[b] - cur.cats[a]; });
  if (ck.length) {
    h += head('Where it went');
    ck.slice(0, 8).forEach(function (c) {
      var v = cur.cats[c], b = budgets[c], pct = cur.out ? v / cur.out * 100 : 0, was = last.cats[c] || 0;
      var note = b ? (v > b ? '<span style="color:' + red + '">over budget by ' + n0(v - b) + '</span>' : '<span style="color:' + green + '">' + Math.round(v / b * 100) + '% of ' + n0(b) + ' budget</span>') :
        (was ? (v > was ? '▲ ' : '▼ ') + n0(Math.abs(v - was)) + ' vs last month' : 'new this month');
      h += '<tr><td style="padding:6px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:15px">' + esc_(c) + '</td><td align="right" style="font-size:15px;' + mono + '">' + fmt_(v) + '</td></tr>' +
        '<tr><td colspan="2" style="padding-top:4px"><div style="height:6px;background:#E2E7DF;border-radius:3px"><div style="height:6px;width:' + Math.max(2, pct).toFixed(1) + '%;background:' + (b && v > b ? red : blue) + ';border-radius:3px"></div></div></td></tr>' +
        '<tr><td colspan="2" style="font-size:12px;color:' + muted + ';padding-top:3px">' + Math.round(pct) + '% of spending · ' + note + '</td></tr></table></td></tr>';
    });
    if (ck.length > 8) h += '<tr><td style="font-size:12px;color:' + muted + '">+ ' + (ck.length - 8) + ' smaller categories</td></tr>';
  }
  var over = Object.keys(budgets).filter(function (c) { return (cur.cats[c] || 0) <= budgets[c]; });
  if (Object.keys(budgets).length) h += '<tr><td style="padding-top:10px;font-size:14px">Budgets: <b>' + over.length + ' of ' + Object.keys(budgets).length + '</b> kept</td></tr>';
  var pk = Object.keys(cur.places).sort(function (a, b) { return cur.places[b].v - cur.places[a].v; }).slice(0, 5);
  if (pk.length) {
    h += head('Top places');
    pk.forEach(function (k, i) {
      h += '<tr><td style="padding:5px 0;border-bottom:1px solid ' + line + '"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:14px">' + (i + 1) + '. ' + esc_(k) +
        ' <span style="color:' + muted + ';font-size:12px">×' + cur.places[k].n + '</span></td><td align="right" style="font-size:14px;' + mono + '">' + fmt_(cur.places[k].v) + '</td></tr></table></td></tr>';
    });
  }
  if (cur.big.length) {
    h += head('Biggest payments');
    cur.big.slice(0, 5).forEach(function (r) {
      h += '<tr><td style="padding:5px 0;border-bottom:1px solid ' + line + '"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="font-size:14px">' + esc_(r.party || r.category) +
        ' <span style="color:' + muted + ';font-size:12px">' + Utilities.formatDate(new Date(r.time), TZ, 'd MMM') + '</span></td><td align="right" style="font-size:14px;' + mono + '">' + fmt_(r.amount) + '</td></tr></table></td></tr>';
    });
  }
  if (!cur.nOut && !cur.inn) h += '<tr><td style="padding-top:18px;font-size:15px;color:' + muted + '">Nothing was recorded this month.</td></tr>';
  var url = ''; try { url = ScriptApp.getService().getUrl(); } catch (e) {}
  if (url) h += '<tr><td style="padding-top:26px"><a href="' + esc_(url + '?key=' + key_()) + '" style="display:inline-block;background:' + blue + ';color:#fff;text-decoration:none;padding:11px 18px;border-radius:10px;font-weight:600;font-size:14px">Open dashboard</a></td></tr>';
  h += '<tr><td style="padding-top:18px;font-size:11px;color:' + muted + '">AED only. Transfers between your own accounts are left out. Sent by your My Money sheet' + (preview ? '; the full report arrives on the 1st of each month.' : '.') + '</td></tr>';
  h += '</table></td></tr></table></div>';
  var subject = (preview ? 'My Money preview · ' : 'My Money · ') + monthName_(mk) + ': spent AED ' + n0(cur.out) + (cur.inn ? ', in AED ' + n0(cur.inn) : '');
  var plain = subject + '\nMoney in AED ' + fmt_(cur.inn) + ', out AED ' + fmt_(cur.out) + ', net AED ' + fmt_(net) + '\n' +
    ck.slice(0, 8).map(function (c) { return c + ': ' + fmt_(cur.cats[c]); }).join('\n');
  return { subject: subject, html: h, text: plain };
}

function sendReport_(mk, preview) {
  var rows = readRows_(ss_().getSheetByName(SHEET_TX)), r = reportHtml_(mk, rows, preview);
  var to = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail({ to: to, subject: r.subject, body: r.text, htmlBody: r.html, name: 'My Money' });
  return 'Sent "' + r.subject + '" to ' + to;
}

// ===================== All-time analysis =====================
// Compact list of every money-in and money-out (AED only, own transfers left out) for the All time page.
function getAllData(key) {
  if (key !== key_()) throw new Error('Not allowed');
  var rows = readRows_(ss_().getSheetByName(SHEET_TX)), out = [], other = 0;
  rows.forEach(function (r) {
    if (r.type !== 'In' && r.type !== 'Out') return;
    if (r.currency !== 'AED') { other++; return; }
    out.push({ d: dayKey_(r.time), h: +Utilities.formatDate(new Date(r.time), TZ, 'H'), t: r.type, a: r.amount, c: r.category, p: r.party || '', w: /wallet/.test(r.source) ? 1 : 0 });
  });
  out.sort(function (a, b) { return a.d < b.d ? -1 : (a.d > b.d ? 1 : 0); });
  var st = streak_(rows);
  return { today: dayKey_(Date.now()), rows: out, other: other, budgets: budgets_(), best: st.best, current: st.current };
}
