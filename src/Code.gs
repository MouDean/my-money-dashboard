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

function num_(s) {
  if (!/^(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/.test(String(s))) return NaN;
  return Math.round(Number(String(s).replace(/,/g, '')) * 100) / 100;
}
function squash_(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
// A person's name from a transfer line: "AANI Transfer, FAM SARA AHMED KHAN" -> "Sara Ahmed Khan".
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
  var amount = last ? num_(last) : NaN;
  return Number.isFinite(amount) ? amount : '';
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
  var t = normalizeBankText_(text), m;
  if (!t) return { ignore: 'empty' };
  if (/\bOTP\b|one[- ]time password|verification code|passcode|activation code|رمز التحقق|كلمة مرور لمرة واحدة/i.test(t)) return { ignore: 'one-time password' };
  if (/declin|not approved|unsuccessful|was rejected|could not be processed|insufficient|تم رفض|غير كاف/i.test(t)) return { ignore: 'declined' };
  var bank = detectBank(sender, t);
  var bal = findBalance(t);
  var CUR = '(' + CURRENCIES + ')';
  var AMT = '([\\d,]+(?:\\.\\d+)?)';
  function out(o) {
    if (!Number.isFinite(o.amount) || o.amount <= 0) return { unknown: true, bank: bank };
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
  if ((m = t.match(new RegExp('(?:Trx\\.?|Transaction|Purchase|Payment|Refund|Reversal)\\s+of\\s+' + CUR + '\\s?' + AMT +
      '\\s+(?:on|from|debited from|made on|made with|using|with)\\s+your\\s+(?:credit |debit |covered |prepaid )?(?:card|a\\/c|account)\\s*(?:no\\.?\\s*)?(?:ending(?: with)?\\s*)?[*xX]*(\\d{3,4})\\s+at\\s+(.+?)(?=\\s+is approved|\\s+on \\d|\\.\\s+(?:Avl|Av\\b|Available|Your|Trx)|\\.?$)', 'i')))) {
    var refund = /^(?:refund|reversal)/i.test(m[0]) || /\b(?:refund|reversal)\s+(?:of\s+)?$/i.test(t.slice(Math.max(0, m.index - 16), m.index));
    return out({ type: refund ? 'In' : 'Out', flow: refund ? 'in' : 'out', kind: refund ? 'refund' : 'purchase',
      currency: m[1], amount: num_(m[2]), account: '*' + m[3], party: m[4] });
  }

  // Looser purchase wording used by other banks: "Purchase of AED 25.00 with Debit Card ending 1234 at CARREFOUR on ..."
  if ((m = t.match(new RegExp('(?:purchase|spent|payment|trx\\.?|transaction)\\b\\.?\\s+(?:of\\s+)?' + CUR + '\\s?' + AMT +
      '.{0,60}?(?:card|a\\/c|account)\\D{0,25}(\\d{3,4}).{0,30}?\\bat\\s+(.+?)(?=\\s+on\\s+\\d|\\s+is approved|\\.\\s|,\\s*(?:avl|available)|\\.?$)', 'i'))) &&
      !/credited/i.test(t)) {
    return out({ type: 'Out', flow: 'out', kind: 'purchase', currency: m[1], amount: num_(m[2]), account: '*' + m[3], party: m[4] });
  }

  // Al Hilal: "Transfer of 340.00 AED to Omar Khalid from account ending with 5678. New balance: ..."
  if ((m = t.match(new RegExp('Transfer of ' + AMT + ' ?' + CUR + ' to (.+?) from (?:your )?account ending (?:with )?(\\d+)', 'i')))) {
    return out({ type: 'Out', flow: 'out', kind: 'transfer', currency: m[2], amount: num_(m[1]), party: m[3], account: '*' + m[4] });
  }

  // Al Hilal: "14249.40 AED credited to account ending with 5678 for WPS Transfers, Salary Jul2025. Balance: ..."
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
    var to = t.slice(m.index + m[0].length).match(/\bto\s+([\p{L}][\p{L}\p{M} .'-]{1,79}?)(?=\s+(?:on|from)\s|\.(?:\s|$)|$)/iu);
    return out({ type: 'Out', flow: 'out', kind: 'transfer', currency: m[1], amount: num_(m[2]),
      account: '*' + m[3].slice(-4), party: to ? to[1] : '' });
  }

  // ADCB: "A Cr. transaction of AED 130.00 on your account number XXX810001 was successful."
  if ((m = t.match(new RegExp('A (Cr|Dr)\\.? transaction of ' + CUR + ' ?' + AMT + ' on your (?:account|card)(?: number| no\\.?)? ?[xX*]*(\\d+)', 'i')))) {
    var cr = /cr/i.test(m[1]);
    return out({ type: cr ? 'In' : 'Out', flow: cr ? 'in' : 'out', kind: 'account', currency: m[2], amount: num_(m[3]), account: '*' + m[4].slice(-4) });
  }

  // ADIB and others: "Dear Customer, AED 6000.00 was credited to your account *4321."
  if ((m = t.match(new RegExp(CUR + ' ?' + AMT + ' (?:was|has been|is) (debited|credited|withdrawn|deposited|transferred)\\s+(from|to|in|into)\\s+your\\s+(?:account|a\\/c|card)\\s*(?:no\\.?|number)?\\s*[*xX]*(\\d+)', 'i')))) {
    var inn = /credited|deposited/i.test(m[3]) || (/transferred/i.test(m[3]) && !/^from$/i.test(m[4]));
    var k = /withdrawn/i.test(m[3]) || /ATM/i.test(t) ? 'cash' : 'account';
    return out({ type: inn ? 'In' : 'Out', flow: inn ? 'in' : 'out', kind: k, currency: m[1], amount: num_(m[2]), account: '*' + m[5].slice(-4) });
  }

  // Generic wording can describe a balance as well as a transaction.
  var hasCurrencyAmount = new RegExp(CUR + '\\s*' + AMT + '|' + AMT + '\\s*' + CUR, 'i').test(t);
  var bankWording = /debit|credit|purchase|refund|reversal|salary|transfer|withdraw|deposit|charged|balance|خصم|إيداع|ايداع|رصيد|تحويل|بطاق/i.test(t);
  if (hasCurrencyAmount || (knownBank_(bank) && bankWording)) return { unknown: true, bank: bank };
  return { ignore: 'no amount' };
}

// ----- categories -----
var DEFAULT_RULES = [
  ['Rent', 'rent, landlord, ejari, real estate, property management'],
  ['Groceries', 'carrefour, lulu, spinneys, union coop, waitrose, choithrams, al maya, grandiose, abu dhabi coop, kibsons, viva, supermarket, hypermarket, baqala, grocery, nesto, west zone'],
  ['Food', 'restau, restaurant, cafeteria, mcdonald, kfc, burger, pizza, shawarma, talabat, deliveroo, noon food, careem food, bakery, grill, kitchen, eatery, sweets, juice, five guys, shake shack, nandos, hardees, subway, popeyes, al baik, mandi, biryani, food, baskin robbins, baskin, ice cream, gelato'],
  ['Coffee & tea', 'coffee, cafe, café, starbucks, costa, tim hortons, dunkin, karak, tea, espresso, arabica, caribou, pret, cafeteria karak'],
  ['Home utilities', 'lpg, gas cylinder, cooking gas'],
  ['Fuel', 'adnoc, enoc, eppco, emarat, petrol, fuel'],
  ['Transport', 'careem, uber, taxi, salik, darb, rta, parking, mawaqif, itc, bus, metro, hala, yango, q mobility'],
  ['Bills & phone', 'etisalat, e& , du, virgin mobile, taqa, addc, aadc, sewa, dewa, fewa, empower, tabreed, zakhir, internet'],
  ['Shopping', 'noon, amazon, namshi, ikea, centrepoint, max fashion, h&m, zara, sharaf dg, virgin megastore, jumbo, shein, temu, mall, splash, home centre, ace hardware, dragon mart'],
  ['Health', 'pharmacy, aster, boots, clinic, hospital, medical, nmc, burjeel, cleveland, dental, optic'],
  ['Government & post', 'emirates post, icp, mohre, tamm, smart services, traffic, ministry, municipality, police, court, visa, ded'],
  ['Education', 'university, univer, school, college, academy, nursery, institute, course'],
  ['Subscriptions', 'netflix, spotify, apple.com, icloud, google, youtube, osn, shahid, anghami, openai, chatgpt, anthropic, claude, adobe, microsoft, disney'],
  ['Travel', 'emirates airline, etihad, flydubai, air arabia, booking.com, airbnb, hotel, agoda, expedia'],
  ['Entertainment', 'vox, cinema, novo, reel cinemas, ticketmaster, platinumlist, gaming, playstation, steam'],
  ['Charity', 'zakat, red crescent, charity, awqaf, donation'],
  ['Family', ''],
  ['Investments', 'sarwa, stake, baraka, interactive brokers, ibkr, etoro, binance, rain, gold, sukuk, mutual fund']
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
  if (tx.kind === 'transfer') return tx.type === 'In' ? (tx.party ? 'From people' : 'Money in') : 'To people';
  // A plain "AED x was debited from your account" with no name is almost always money sent to a friend.
  if (tx.kind === 'account' && tx.type === 'Out' && !tx.party) return tx.amount <= 5 ? 'Other' : 'To people';
  if (tx.type === 'Out' && !tx.party && tx.amount <= 10) return 'Other';
  if (tx.type === 'In') return 'Money in';
  return 'Other';
}

// Paying the credit card bill from a bank account. Saved as an own move (type Own) so it isn't counted
// as spending again: the card purchases themselves were already counted.
var CARD_BILL = 'Credit card';
function isCardPay_(r) { return !!r && r.type === 'Info' && /^card payment$/i.test(String(r.party || '')); }

// ----- matching against recent rows -----
// Returns what to do with a new transaction:
//   skip  - same message already saved, or a Wallet tap the SMS already covered
//   merge - an SMS that completes an earlier Wallet tap (fill bank, account, balance)
//   add   - a new row; ownWith lists rows to mark as "between my accounts"
function normalizeBankText_(value) {
  return squash_(value).replace(/[\u0660-\u0669\u06f0-\u06f9]/g, function (digit) {
    return String(digit.charCodeAt(0) & 15);
  }).replace(/\u066b/g, '.').replace(/\u066c/g, ',').replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}

function paymentEventId_(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : '';
}

// Keep event IDs with their payment without adding sheet columns.
var EVENT_MARKER_ = '\nMy Money events: ';
function paymentText_(value) {
  var text = String(value || ''), at = text.lastIndexOf(EVENT_MARKER_);
  if (at >= 0) {
    try {
      var ids = JSON.parse(text.slice(at + EVENT_MARKER_.length));
      if (Array.isArray(ids) && ids.length === 2) {
        return { text: text.slice(0, at), smsEvent: paymentEventId_(ids[0]), walletEvent: paymentEventId_(ids[1]) };
      }
    } catch (err) { /* Old text can be read as-is. */ }
  }
  return { text: text, smsEvent: '', walletEvent: '' };
}

function storedPaymentText_(r) {
  var text = r.text || '';
  return r.smsEvent || r.walletEvent ? text + EVENT_MARKER_ + JSON.stringify([r.smsEvent || '', r.walletEvent || '']) : text;
}

function findPaymentEvent_(sh, tx, recent) {
  var field = tx.source === 'wallet' ? 'walletEvent' : 'smsEvent', eventId = tx[field];
  if (!eventId) return null;
  var saved = recent.find(function (r) { return r[field] === eventId; });
  if (saved || sh.getLastRow() <= recent.length + 1) return saved || null;
  var matches = sh.getRange(2, COL.Text + 1, sh.getLastRow() - recent.length - 1, 1)
    .createTextFinder(JSON.stringify(eventId)).matchCase(true).findAll();
  for (var i = 0; i < matches.length; i++) {
    var cell = matches[i];
    if (paymentText_(cell.getValue())[field] === eventId) {
      return { row: cell.getRow(), lat: cell.offset(0, 1).getValue() };
    }
  }
  return null;
}

function cardEnding_(value) {
  var match = String(value || '').match(/(?:[*xX]+|ending(?: with)?\s+|(?:^|\s))(\d{3,4})\s*\)?$/i);
  return match ? match[1] : '';
}

function merchantForMatch_(value) {
  return normalizeBankText_(value).normalize('NFKC').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
// Apple Pay often names the branch ("Grandiose- Marina Mall Branch, ...") while the bank SMS names the
// company ("GRANDIOSE SUPERMARKET"). Treat them as the same shop when the first real word matches
// (4+ letters, or the first two words when the first is short like "tea time").
function merchantAgree_(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  var STOP = { the: 1, al: 1, el: 1, abu: 1, dhabi: 1, dubai: 1, uae: 1, llc: 1, co: 1, and: 1, of: 1 };
  var words = function (s) { return s.split(' ').filter(function (w) { return w.length >= 3 && !STOP[w]; }); };
  var wa = words(a), wb = words(b);
  if (!wa.length || !wb.length || wa[0] !== wb[0]) return false;
  return wa[0].length >= 4 || (wa.length > 1 && wb.length > 1 && wa[1] === wb[1]);
}

function knownBank_(value) {
  return BANKS.some(function (bank) { return bank[0] === value && value !== 'Apple Pay'; });
}

function transferReference_(value) {
  var ref = normalizeBankText_(value).match(/\b(?:reference|ref\.?)(?:\s+(?:number|no\.?|id))?(?:\s*[:#-]\s*|\s+)([A-Z0-9-]{6,40})(?![A-Z0-9-])/i);
  return ref && /\d/.test(ref[1]) ? ref[1].toUpperCase() : '';
}

function reconcile(nt, recent) {
  var MIN = 60000, HOUR = 3600000;
  var result = { action: 'add', ownWith: [] };
  function near(r, ms) { return Math.abs(r.time - nt.time) <= ms; }
  var repeated = nt.text && recent.find(function (r) {
    return r.text === nt.text && near(r, 48 * HOUR) && !(r.smsEvent && nt.smsEvent && r.smsEvent !== nt.smsEvent);
  });
  if (repeated) {
    if (nt.smsTimed) return { action: 'skip', why: 'already saved', id: repeated.id };
    return { action: 'review', why: 'Identical SMS without a transaction timestamp', ids: [repeated.id] };
  }

  var isWallet = nt.source === 'wallet', opposite = isWallet ? 'sms' : 'wallet';
  if ((isWallet || nt.source === 'sms') && nt.kind === 'purchase' && (nt.type === 'Out' || nt.type === 'Own')) {
    var ending = cardEnding_(nt.account), merchant = merchantForMatch_(nt.party);
    var candidates = [];
    recent.forEach(function (r) {
      if (r.source !== opposite || r.kind !== 'purchase' || (r.type !== 'Out' && r.type !== 'Own') || r.merged ||
          r.amount !== nt.amount || r.currency !== nt.currency || !near(r, 20 * MIN)) return;
      if (knownBank_(r.bank) && knownBank_(nt.bank) && r.bank !== nt.bank) return;
      var otherEnding = cardEnding_(r.account), overlap = Math.min(ending.length, otherEnding.length);
      if (overlap && ending.slice(-overlap) !== otherEnding.slice(-overlap)) return;
      var otherMerchant = merchantForMatch_(r.party);
      var sameMerchant = merchantAgree_(merchant, otherMerchant);
      candidates.push({ id: r.id, strong: sameMerchant && (overlap || near(r, 5 * MIN)) });
    });
    if (candidates.length === 1 && candidates[0].strong) return { action: 'merge', id: candidates[0].id };
    if (candidates.length) return {
      action: 'review', why: 'Wallet and SMS match needs confirmation',
      ids: candidates.map(function (r) { return r.id; })
    };
  }

  function unnamedTransfer(r) {
    return !r.party && (r.type === 'In' || r.type === 'Out') && (r.kind === 'transfer' || r.kind === 'account');
  }
  function ownSignal(signal, other) {
    return (signal.type === 'Own' && signal.flow !== other.flow) ||
      (signal.type === 'Info' && signal.toOwner && other.type === 'Out');
  }
  if (nt.source === 'sms' && (nt.type === 'Own' || nt.type === 'Info' || unnamedTransfer(nt))) {
    var possible = recent.filter(function (r) {
      return r.source === 'sms' && !r.pair && r.amount === nt.amount && r.currency === nt.currency && near(r, 48 * HOUR) &&
        ((unnamedTransfer(nt) && ownSignal(r, nt)) || (unnamedTransfer(r) && ownSignal(nt, r)));
    });
    if (possible.length) {
      var reference = transferReference_(nt.text);
      // A card-bill confirmation ("payment ... for card ending *1234 has been credited") with the same amount
      // is enough on its own: those SMS carry no transfer reference to compare.
      if (possible.length === 1 && (isCardPay_(nt) || isCardPay_(possible[0]) || (reference && reference === transferReference_(possible[0].text)))) {
        result.ownWith = [possible[0].id];
        result.selfOwn = nt.type !== 'Info';
      } else {
        result.review = possible.map(function (r) { return r.id; });
      }
    }
  }
  return result;
}

function parseWalletAmount_(amount, currency) {
  var text = normalizeBankText_(amount);
  var m = text.match(/^(?:([A-Z]{3})\s*)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(?:\s*([A-Z]{3}))?$/i);
  if (!m || (m[1] && m[3])) return null;
  var labelled = (m[1] || m[3] || '').toUpperCase(), supplied = squash_(currency).toUpperCase();
  var cur = supplied || labelled || 'AED', value = num_(m[2]);
  if (!(new RegExp('^(?:' + CURRENCIES + ')$')).test(cur) || (supplied && labelled && supplied !== labelled) ||
      !Number.isFinite(value) || value <= 0) return null;
  return { amount: value, currency: cur };
}

function walletPoint_(b) {
  var lat = b.lat, lng = b.lng;
  if (lat === undefined || lng === undefined || lat === '' || lng === '' || lat === null || lng === null) {
    var match = String(b.location || '').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!match) return null;
    lat = match[1]; lng = match[2];
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(String(lat).trim()) || !/^-?\d+(?:\.\d+)?$/.test(String(lng).trim())) return null;
  lat = Number(lat); lng = Number(lng);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat: lat, lng: lng } : null;
}

function reviewPayment_(source, b, reason, ids) {
  var sender = String(source === 'sms' ? b.sender || 'SMS' : 'Wallet');
  if (sender.charAt(0) === '=') sender = "'" + sender;
  var details = source === 'sms' ? String(b.text || '') : JSON.stringify({
    merchant: b.merchant, card: b.card, amount: b.amount, currency: b.currency,
    eventId: paymentEventId_(b.eventId), point: walletPoint_(b)
  });
  var message = reason + (ids && ids.length ? ' (transaction IDs: ' + ids.join(', ') + ')' : '') + '\n' + details;
  ss_().getSheetByName(SHEET_REV).appendRow([new Date(), sender, message.slice(0, 4000)]);
  return 'Saved for review: ' + reason;
}

function mergedPurchase_(saved, incoming) {
  var sms = incoming.source === 'sms' ? incoming : saved;
  var wallet = incoming.source === 'wallet' ? incoming : saved;
  var hasPoint = saved.lat !== '' && saved.lat !== undefined;
  return Object.assign({}, saved, {
    time: incoming.smsTimed ? incoming.time : saved.time,
    bank: sms.bank || saved.bank,
    account: sms.account || saved.account,
    party: saved.party || incoming.party,
    balance: sms.balance,
    source: 'wallet+sms',
    text: sms.text,
    smsEvent: sms.smsEvent,
    walletEvent: wallet.walletEvent,
    lat: hasPoint ? saved.lat : wallet.lat,
    lng: hasPoint ? saved.lng : wallet.lng
  });
}


// ===================== Google Sheet side =====================
var TZ = 'Asia/Dubai';
var SHEET_TX = 'Transactions', SHEET_CAT = 'Categories', SHEET_SET = 'Settings', SHEET_REV = 'Review';
var HEAD = ['ID', 'Time', 'Type', 'Flow', 'Amount', 'Currency', 'Bank', 'Account', 'Party', 'Category', 'Balance', 'Source', 'Kind', 'Pair', 'Text', 'Lat', 'Lng', 'Note'];
var COL = {}; HEAD.forEach(function (h, i) { COL[h] = i; });

// Run this once from the editor (select "setup", press Run).
function setup() {
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

function ss_() { return SpreadsheetApp.openById(SHEET_ID); }
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
// Card bill payments saved after the card's last balance SMS. The bank's payment SMS has no
// balance, so without this the card shows the old "used" amount until the next purchase.
function cardPaidSince_(rows, account, afterRow) {
  var d = String(account || '').replace(/\D/g, ''), sum = 0, last = 0;
  rows.forEach(function (r) {
    if (r.type === 'Info' && /^card payment$/i.test(String(r.party)) && r.row > afterRow &&
        String(r.account || '').replace(/\D/g, '') === d) { sum += r.amount; if (r.time > last) last = r.time; }
  });
  return { sum: sum, time: last };
}

// One-time update of the Categories and Settings tabs when the script gets new defaults.
// Words you added yourself (for example through "Always use this category") are kept.
var RULES_VERSION = '3';
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
// Budget plan: salary from Settings, budgets per category in the Budgets tab.
var PLAN_VERSION = '1';
// Starter plan written once on first load. Leave salary 0 and budgets empty to set your own from the dashboard
// (Budget plan → Edit). Example: { salary: 10000, budgets: { 'Rent': 2500, 'Groceries': 800, 'Food': 600 } }
var PLAN_DEFAULT = { salary: 0, budgets: {} };
function planOnce_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('PLAN_V') === PLAN_VERSION) return;
  var ss = ss_(), cs = ss.getSheetByName(SHEET_CAT);
  var names = cs.getLastRow() > 1 ? cs.getRange(2, 1, cs.getLastRow() - 1, 1).getValues().map(function (v) { return String(v[0]); }) : [];
  if (names.indexOf('Rent') < 0) { cs.insertRowBefore(2); cs.getRange(2, 1, 1, 2).setValues([[DEFAULT_RULES[0][0], DEFAULT_RULES[0][1]]]); }
  planSalary_(PLAN_DEFAULT.salary);
  if (Object.keys(PLAN_DEFAULT.budgets).length && Object.keys(budgets_()).length === 0) setBudgets(key_(), PLAN_DEFAULT.budgets);
  props.setProperty('PLAN_V', PLAN_VERSION);
}
// Reads the planned monthly salary from Settings (adds the row with `init` if missing, or sets it when `set` is given).
function planSalary_(init, set) {
  var sh = ss_().getSheetByName(SHEET_SET), n = sh.getLastRow();
  var vals = n ? sh.getRange(1, 1, n, 2).getValues() : [];
  for (var i = 0; i < vals.length; i++) if (/^monthly salary/i.test(String(vals[i][0]))) {
    if (set > 0) { sh.getRange(i + 1, 2).setValue(set); return set; }
    return parseFloat(vals[i][1]) || 0;
  }
  var v = set > 0 ? set : (init || 0);
  sh.appendRow(['Monthly salary (for the budget plan)', v]);
  return v;
}
// One-time: unnamed account debits filed as "Other" before the rule above move to "To people".
var ACCT_VERSION = '1';
function acctOnce_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('ACCT_V') === ACCT_VERSION) return;
  var sh = ss_().getSheetByName(SHEET_TX), n = sh.getLastRow();
  if (n > 1) {
    var v = sh.getRange(2, 1, n - 1, 13).getValues(), changed = false;
    v.forEach(function (r, i) {
      if (r[2] === 'Out' && r[12] === 'account' && !String(r[8]).trim() && r[9] === 'Other' && Number(r[4]) > 5) { sh.getRange(i + 2, 10).setValue('To people'); changed = true; }
    });
  }
  props.setProperty('ACCT_V', ACCT_VERSION);
}
function upgrade_() {
  try { peopleOnce_(); } catch (e) { console.error(e); }
  try { acctOnce_(); } catch (e) { console.error(e); }
  try { planOnce_(); } catch (e) { console.error(e); }
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
      // Rules v3: payments still in Other get another look with the new words (Baskin Robbins -> Food, Q Mobility / Darb -> Transport).
      var pv = tx.getRange(2, COL.Party + 1, tn, 1).getValues(), tv = tx.getRange(2, COL.Type + 1, tn, 1).getValues(), rl = rulesFromTable(rows);
      cv.forEach(function (v, i) { if (v[0] === 'Other' && tv[i][0] === 'Out' && String(pv[i][0]).trim()) { var c = categorize({ type: 'Out', party: String(pv[i][0]) }, rl); if (c && c !== 'Other') v[0] = c; } });
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
// Money moved to Investments or Saving is set aside, not spent: it still leaves the account (so it lowers
// "left until payday"), but it doesn't count as spending, break a no-spend streak or show up as a place.
var SET_ASIDE = ['Investments', 'Saving'];
var NOT_PLACE = ['cash', 'money in', 'card payment', 'salary', 'added by hand', 'marked paid'];
// A real shop or named person: not empty, not just the category name (Rent, Family marked paid), not a generic word.
function isPlace_(party, category) { var p = String(party || '').trim().toLowerCase(); return !!p && p !== String(category || '').toLowerCase() && NOT_PLACE.indexOf(p) < 0; }
function isAside_(r) { return r.type === 'Out' && SET_ASIDE.indexOf(r.category) >= 0; }
function isPayPeriodRow_(r, start) {
  return r.day >= start && r.currency === 'AED' && (r.type === 'In' || r.type === 'Out');
}
function period_(rows) {
  var pd = payday_(), sal = null;
  rows.forEach(function (r) { if (r.type === 'In' && r.category === 'Salary' && r.currency === 'AED' && (!sal || r.time > sal.time)) sal = r; });
  if (!sal) { // no salary yet: everything that came in since the last expected payday fills the jar
    var td = dayKey_(Date.now()), tp = td.split('-'), lp = new Date(Date.UTC(+tp[0], +tp[1] - 1, pd));
    if (dayKey_(lp.getTime()) > td) lp = new Date(Date.UTC(+tp[0], +tp[1] - 2, pd));
    var from = lp.toISOString().slice(0, 10), inn = 0, out = 0, last = 0;
    rows.forEach(function (r) {
      if (r.currency !== 'AED' || r.day < from) return;
      if (r.type === 'In') { inn += r.amount; if (r.time > last) last = r.time; } else if (r.type === 'Out') out += r.amount;
    });
    return { none: true, payday: pd, from: from, inn: inn, spent: out, lastIn: last ? dayKey_(last) : '', today: td };
  }
  var start = dayKey_(sal.time), today = dayKey_(Date.now());
  var p = start.split('-'), y = +p[0], m = +p[1], d = +p[2];
  var nx = new Date(Date.UTC(y, (d >= 10 ? m : m - 1), pd));
  if (nx.getTime() <= keyToUTC_(start)) nx = new Date(Date.UTC(y, m, pd));
  var next = nx.toISOString().slice(0, 10);
  var salary = 0, spent = 0, otherIn = 0, n = 0, preIn = 0, aside = 0, m1 = today.slice(0, 8) + '01';
  rows.forEach(function (r) {
    if (!isPayPeriodRow_(r, start)) return;
    var k = r.day;
    if (r.type === 'In' && k < m1) preIn += r.amount; // came in after payday but before this month started
    if (r.type === 'In' && r.category === 'Salary') salary += r.amount;
    else if (r.type === 'In') otherIn += r.amount;
    else if (r.type === 'Out') { spent += r.amount; if (SET_ASIDE.indexOf(r.category) >= 0) aside += r.amount; else n++; }
  });
  var daysLeft = Math.max(0, Math.round((keyToUTC_(next) - keyToUTC_(today)) / 86400000));
  var daysIn = Math.round((keyToUTC_(today) - keyToUTC_(start)) / 86400000) + 1;
  var left = salary + otherIn - spent; // everything that came in since payday (salary, side income, money back) minus spending
  return { start: start, next: next, today: today, salary: salary, spent: spent, aside: aside, left: left, otherIn: otherIn, preIn: preIn, payments: n,
    daysLeft: daysLeft, daysIn: daysIn, perDay: daysLeft > 0 ? left / daysLeft : left, party: sal.party };
}

function text_(s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT); }
function fmt_(n) { return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!p.key || p.key !== key_()) return text_('Not allowed. Add ?key=YOUR_KEY to the link.');
  setupOnce_();
  if (p.action === 'summary') return text_(dailySummary_());
  if (p.action === 'add') return text_(ingest_(p));
  var t = HtmlService.createTemplateFromFile('Dashboard');
  t.key = p.key;
  return t.evaluate().setTitle('My Money')
    .setFaviconUrl('https://raw.githubusercontent.com/MouDean/my-money-dashboard/main/docs/icon.png') // 金 seal: tab + installed desktop app icon
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

// One-time upgrades and fixes. They used to be checked on every page load; now they only run when
// SETUP_V changes, so opening the dashboard is quicker. Add a new fix -> call it here and bump SETUP_V.
var SETUP_V = '69';
function setupOnce_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SETUP_DONE') === SETUP_V) return;
  upgrade_();
  try { overviewOnce_(); } catch (err) { console.error(err); }
  try { familyOnce_(); } catch (err) { console.error(err); }
  try { fixesOnce_(); } catch (err) { console.error(err); }
  try { fixes2_(); } catch (err) { console.error(err); }
  try { fixes3_(); } catch (err) { console.error(err); }
  try { fixes4_(); } catch (err) { console.error(err); }
  try { fixes5_(); } catch (err) { console.error(err); }
  try { fixes6_(); } catch (err) { console.error(err); }
  try { fixes7_(); } catch (err) { console.error(err); }
  try { fixes8_(); } catch (err) { console.error(err); }
  try { fixes9_(); } catch (err) { console.error(err); }
  try { alertsOnce_(); } catch (err) { console.error(err); }
  try { calendarOnce_(); } catch (err) { console.error(err); }
  props.setProperty('SETUP_DONE', SETUP_V);
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
  var vals = sh.getRange(start, 1, sh.getLastRow() - start + 1, Math.min(HEAD.length, sh.getMaxColumns())).getValues();
  var own = owners_();
  return vals.map(function (v, i) {
    var time = v[1] instanceof Date ? v[1].getTime() : new Date(v[1]).getTime();
    var message = paymentText_(v[14]);
    // day is worked out once per row here: formatting dates is the slowest step when the sheet grows.
    return { row: start + i, id: String(v[0]), time: time, day: dayKey_(time),
      type: v[2], flow: v[3], amount: Number(v[4]), currency: v[5], bank: v[6], account: v[7], party: v[8],
      category: v[9], balance: v[10], source: v[11], kind: v[12], pair: String(v[13] || ''), text: message.text, smsEvent: message.smsEvent, walletEvent: message.walletEvent,
      toOwner: v[2] === 'Info' && (isOwner(v[8], own) || v[8] === 'Card Payment'), merged: /\+/.test(v[11]) || (v[11] === 'sms' && typeof v[15] === 'number' && typeof v[16] === 'number'),
      lat: v[15] === '' ? '' : Number(v[15]), lng: v[16] === '' ? '' : Number(v[16]), note: v[17] == null ? '' : String(v[17]) };
  });
}

function toRow_(t) {
  return [t.id, new Date(t.time), t.type, t.flow, t.amount, t.currency, t.bank, t.account || '', t.party || '',
    t.category, t.balance === '' ? '' : t.balance, t.source, t.kind, t.pair || '', storedPaymentText_(t),
    t.lat === undefined ? '' : t.lat, t.lng === undefined ? '' : t.lng, t.note || ''];
}

// Takes one SMS, Wallet tap or manual entry and saves it.
function headers_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('HEAD_V') === '3') return;
  var tsh = ss_().getSheetByName(SHEET_TX);
  if (tsh.getMaxColumns() < HEAD.length) tsh.insertColumnsAfter(tsh.getMaxColumns(), HEAD.length - tsh.getMaxColumns());
  tsh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold');
  props.setProperty('HEAD_V', '3');
}

function ingest_(b) {
  headers_();
  var source = String(b.source || 'sms').toLowerCase();
  var src = source === 'wallet' || source === 'manual' ? source : 'sms';
  var tx;
  if (src === 'wallet') {
    var amt = parseWalletAmount_(b.amount, b.currency);
    if (!amt) return reviewPayment_(src, b, 'Wallet amount or currency was unclear');
    var card = squash_(b.card), point = walletPoint_(b);
    tx = { type: 'Out', flow: 'out', kind: 'purchase', amount: amt.amount, currency: amt.currency,
      bank: detectBank(card, card), account: card, party: title_(b.merchant || ''), balance: '',
      walletEvent: paymentEventId_(b.eventId) };
    if (point) { tx.lat = point.lat; tx.lng = point.lng; }
  } else if (src === 'manual') {
    tx = { type: b.type === 'In' ? 'In' : 'Out', flow: b.type === 'In' ? 'in' : 'out', kind: 'manual',
      amount: Math.round(parseFloat(b.amount) * 100) / 100, currency: 'AED', bank: b.bank || 'Cash', account: '',
      party: title_(b.party || ''), balance: '', category: b.category || '', note: String(b.note || '').slice(0, 500) };
    if (!(tx.amount > 0)) return 'Skipped: amount missing';
    tx.when = manualTime_(b.date);
  } else {
    tx = parseMessage(b.text, b.sender, owners_());
    if (tx.ignore) return 'Ignored: ' + tx.ignore;
    if (tx.unknown) return reviewPayment_(src, b, 'SMS format was unclear');
    tx.text = squash_(b.text);
    tx.smsEvent = paymentEventId_(b.eventId);
    var td = trxDate_(b.text);
    if (td) { tx.when = td; tx.smsTimed = true; }
    else if (/Trx\.?\s*Date/i.test(tx.text)) return reviewPayment_(src, b, 'SMS transaction date was unclear');
  }
  // "as=own" marks a transfer between my own accounts (used for links I tap by hand).
  if (String(b.as || '').toLowerCase() === 'own' && tx.type !== 'Info') { tx.type = 'Own'; tx.category = 'Between my accounts'; }
  tx.source = src;
  tx.time = tx.when || Date.now(); delete tx.when;
  tx.id = Utilities.getUuid().slice(0, 8); LAST_ID_ = tx.id;

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = ss_().getSheetByName(SHEET_TX);
    var recent = readRows_(sh, 300);
    var duplicate = findPaymentEvent_(sh, tx, recent);
    if (duplicate) {
      if (src === 'wallet' && tx.lat !== undefined && duplicate.lat === '') {
        sh.getRange(duplicate.row, COL.Lat + 1, 1, 2).setValues([[tx.lat, tx.lng]]);
      }
      return 'Skipped: already saved';
    }
    var d = reconcile(tx, recent);
    if (d.action === 'review') return reviewPayment_(src, b, d.why, d.ids);
    if (d.action === 'skip') return 'Skipped: ' + d.why;
    var byId = {}; recent.forEach(function (r) { byId[r.id] = r; });
    if (d.action === 'merge') {
      var merged = mergedPurchase_(byId[d.id], tx);
      sh.getRange(merged.row, 1, 1, HEAD.length).setValues([toRow_(merged)]);
      return 'Matched with Wallet: ' + tx.currency + ' ' + fmt_(tx.amount) + ' ' + merged.party;
    }
    if (d.selfOwn && tx.type !== 'Info') tx.type = 'Own';
    if (d.ownWith.length) {
      tx.pair = d.ownWith[0];
      d.ownWith.forEach(function (oid) {
        var r = byId[oid]; if (!r) return;
        if (r.type !== 'Info') { sh.getRange(r.row, COL.Type + 1).setValue('Own'); sh.getRange(r.row, COL.Category + 1).setValue(isCardPay_(tx) ? CARD_BILL : 'Between my accounts'); }
        sh.getRange(r.row, COL.Pair + 1).setValue(tx.id);
      });
    }
    if (!tx.category && tx.type !== 'Own') tx.category = merchantCategory_(tx);
    if (!tx.category || tx.category === 'Between my accounts' && tx.type !== 'Own') tx.category = categorize(tx, rules_());
    if (tx.type === 'Own') tx.category = tx.pair && isCardPay_(byId[tx.pair]) ? CARD_BILL : 'Between my accounts';
    sh.appendRow(toRow_(tx));
    ALERT_TX_ = tx;
    if (d.review) {
      try { reviewPayment_(src, b, 'Possible own transfer', [tx.id].concat(d.review)); }
      catch (err) { console.error('Could not flag a possible own transfer'); }
    }
    return 'Saved: ' + tx.type + ' ' + tx.currency + ' ' + fmt_(tx.amount) + (tx.party ? ' · ' + tx.party : '') + ' · ' + tx.category;
  } finally {
    lock.releaseLock();
    if (ALERT_TX_) { var at = ALERT_TX_; ALERT_TX_ = null; try { alertsFor_(at); } catch (err) { console.error(err); } }
  }
}

// ADIB card SMS end with "Trx Date: 08/11/26 16:40" (UAE time). When the message arrives late
// (e.g. a batch forwarded the next morning) that is the real time of the payment.
var ALERT_TX_ = null;
function trxDate_(text) {
  var m = normalizeBankText_(text).match(/Trx\.?\s*Date:?\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})/i);
  if (!m) return 0;
  var y = +m[3]; if (y < 100) y += 2000;
  var t = Date.UTC(y, +m[2] - 1, +m[1], +m[4] - 4, +m[5]), now = Date.now(); // UAE is UTC+4 all year
  var local = new Date(t + 4 * 3600000);
  if (local.getUTCMonth() + 1 !== +m[2] || local.getUTCDate() !== +m[1] ||
      local.getUTCHours() !== +m[4] || local.getUTCMinutes() !== +m[5]) return 0;
  return (t <= now + 5 * 60000 && now - t < 45 * 86400000) ? t : 0;
}

function dayKey_(ms) { return Utilities.formatDate(new Date(ms), TZ, 'yyyy-MM-dd'); }

function dailySummary_() {
  var rows = readRows_(ss_().getSheetByName(SHEET_TX), 800);
  var today = dayKey_(Date.now()), month = today.slice(0, 7);
  var tOut = 0, tIn = 0, nOut = 0, nIn = 0, mOut = 0, mIn = 0, mAside = 0, tAside = 0, cats = {}, other = 0;
  rows.forEach(function (r) {
    if (r.type !== 'Out' && r.type !== 'In') return;
    var dk = r.day;
    if (r.currency !== 'AED') { if (dk === today) other++; return; }
    if (isAside_(r)) { if (dk.slice(0, 7) === month) mAside += r.amount; if (dk === today) tAside += r.amount; return; }
    if (dk.slice(0, 7) === month) { if (r.type === 'Out') mOut += r.amount; else mIn += r.amount; }
    if (dk !== today) return;
    if (r.type === 'Out') { tOut += r.amount; nOut++; cats[r.category] = (cats[r.category] || 0) + r.amount; }
    else { tIn += r.amount; nIn++; }
  });
  var label = Utilities.formatDate(new Date(), TZ, 'EEE d MMM');
  var lines = [];
  if (!nOut && !nIn && !tAside) lines.push(label + ': nothing recorded today.');
  else {
    lines.push(label + ': spent AED ' + fmt_(tOut) + ' (' + nOut + ')' + (nIn ? ', received AED ' + fmt_(tIn) + ' (' + nIn + ')' : '') + (tAside ? ', set aside AED ' + fmt_(tAside) : ''));
    var top = Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; }).slice(0, 3);
    if (top.length) lines.push('Top: ' + top.map(function (c) { return c + ' ' + fmt_(cats[c]); }).join(', '));
  }
  if (other) lines.push(other + ' payment(s) in another currency, not in totals.');
  lines.push(Utilities.formatDate(new Date(), TZ, 'MMMM') + ' so far: spent AED ' + fmt_(mOut) + (mAside ? ', set aside AED ' + fmt_(mAside) : '') + ', received AED ' + fmt_(mIn));
  var per = period_(rows);
  // Same figures as the dashboard: spent + set aside since payday, left = everything that came in minus both.
  if (!per.none) lines.push('Since payday: spent AED ' + fmt_(per.spent - per.aside) + (per.aside ? ' + set aside AED ' + fmt_(per.aside) : '') +
    ' · left AED ' + fmt_(per.left) + (per.daysLeft > 0 ? ' (AED ' + fmt_(Math.max(0, per.perDay)) + '/day for ' + per.daysLeft + ' days)' : ' · salary due any day'));
  var cards = cards_(), seen = {};
  for (var i = rows.length - 1; i >= 0; i--) {
    var r = rows[i], lim = cardLimit_(cards, r.account);
    if (!lim || seen[r.account] || r.balance === '' || r.balance === null || r.type === 'Info') continue;
    seen[r.account] = 1;
    var av = Math.min(lim, Number(r.balance) + cardPaidSince_(rows, r.account, r.row).sum);
    lines.push('Card ' + r.account + ': used AED ' + fmt_(lim - av) + ' of ' + fmt_(lim));
  }
  var rev = ss_().getSheetByName(SHEET_REV).getLastRow() - 1;
  if (rev > 0) lines.push(rev + ' message(s) waiting in the Review tab.');
  return lines.join('\n');
}

// ----- called by the dashboard page -----
function dashboardTx_(r) {
  return { id: r.id, flow: r.flow, day: r.day, ts: r.time, lat: r.lat, lng: r.lng, hm: Utilities.formatDate(new Date(r.time), TZ, 'HH:mm'), type: r.type, amount: r.amount,
    currency: r.currency, bank: r.bank, account: r.account, party: r.party, category: r.category, source: r.source, note: r.note };
}
function getData(key, month) {
  if (key !== key_()) throw new Error('Not allowed');
  upgrade_();
  headers_();
  var rows = readRows_(ss_().getSheetByName(SHEET_TX));
  var months = {}, balances = {}, list = [], totals = {};
  var cards = cards_();
  var today = dayKey_(Date.now()), current = today.slice(0, 7), pay = period_(rows);
  month = month || current;
  var carry = month === current && !pay.none && pay.salary > 0 ? [] : null;
  rows.forEach(function (r) {
    var dk = r.day, mk = dk.slice(0, 7);
    months[mk] = 1;
    if ((r.type === 'In' || r.type === 'Out') && r.currency === 'AED') {
      totals[mk] = totals[mk] || { 'in': 0, out: 0 };
      if (!isAside_(r)) totals[mk][r.type === 'In' ? 'in' : 'out'] += r.amount; // set-aside money isn't spending
    }
    if (r.balance !== '' && r.balance !== null && r.type !== 'Info') {
      var ak = r.bank + ' ' + (r.account || '');
      if (!balances[ak] || balances[ak].time < r.time) balances[ak] = { bank: r.bank, account: r.account, balance: Number(r.balance), time: r.time, row: r.row, when: Utilities.formatDate(new Date(r.time), TZ, 'd MMM, HH:mm') };
    }
    if (mk === month && r.type !== 'Info') list.push(dashboardTx_(r));
    else if (carry && isPayPeriodRow_(r, pay.start)) carry.push(dashboardTx_(r));
  });
  var cats = ss_().getSheetByName(SHEET_CAT).getRange('A2:A').getValues().map(function (v) { return v[0]; }).filter(String);
  ['Salary', 'Side income', 'From people', 'To people', 'Family', 'Investments', 'Saving', 'Money in', 'Refunds', 'Between my accounts', 'Credit card', 'Other']
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
    if (lim) {
      var paid = cardPaidSince_(rows, b.account, b.row), avail = Math.min(lim, b.balance + paid.sum);
      cardList.push({ bank: b.bank, account: b.account, limit: lim, available: Math.round(avail * 100) / 100, used: Math.max(0, Math.round((lim - avail) * 100) / 100),
        paid: paid.sum, when: paid.sum ? Utilities.formatDate(new Date(paid.time), TZ, 'd MMM, HH:mm') : b.when });
    }
    else accts.push(b);
  });
  return { month: month, today: today, months: Object.keys(months).sort(), rows: list.reverse(), payCarry: carry,
    trend: trend, cards: cardList, balances: accts, period: pay, budgets: budgets_(), plan: { salary: planSalary_(0) }, streak: streak_(rows),
    contracts: contracts_(rows), incoming: incoming_(rows),
    categories: cats, logos: merchantLogos_(), blogos: bizLogos_(list.filter(function (r) { return r.source !== 'manual' && r.party && r.category !== 'To people' && r.category !== 'From people'; }).map(function (r) { return r.party; })), review: Math.max(0, ss_().getSheetByName(SHEET_REV).getLastRow() - 1) };
}

// Change a category, or mark a row as between my accounts / ignored. Optionally teach the rule.
function updateTx(key, id, change) {
  if (key !== key_()) throw new Error('Not allowed');
  var lock = LockService.getScriptLock();
  lock.waitLock(20000); // a bank SMS arriving at the same moment must not shift the row being changed
  try {
    var sh = ss_().getSheetByName(SHEET_TX);
    var rows = readRows_(sh);
    var r = rows.filter(function (x) { return x.id === id; })[0];
    if (!r) throw new Error('Row not found');
    if (change.remove) { sh.deleteRow(r.row); return 'Removed'; }
    var cardBill = change.category === CARD_BILL && change.type !== 'Own';
    if (cardBill) change.type = 'Own'; // a card bill payment is never counted as spending
    if (change.type) sh.getRange(r.row, COL.Type + 1).setValue(change.type);
    if (change.category) sh.getRange(r.row, COL.Category + 1).setValue(change.category);
    if (change.type === 'Own' && !cardBill) sh.getRange(r.row, COL.Category + 1).setValue('Between my accounts');
    if (change.note !== undefined) {
      if (sh.getMaxColumns() < HEAD.length) sh.insertColumnsAfter(sh.getMaxColumns(), HEAD.length - sh.getMaxColumns());
      sh.getRange(1, COL.Note + 1).setValue('Note').setFontWeight('bold');
      sh.getRange(r.row, COL.Note + 1).setValue(String(change.note).slice(0, 500));
    }
    var also = 0;
    if (change.learn && change.category && r.party && change.type !== 'Own' && (r.type === 'In' || r.type === 'Out')) {
      // Exact merchant memory: checked before the keyword rules, so "always" really means always.
      rememberMerchant_(r.party, r.type, change.category);
      // Keyword rule as before, so other branches of the same shop are caught too.
      var word = squash_(r.party).toLowerCase().split(/\s+/).slice(0, 2).join(' ');
      var cs = ss_().getSheetByName(SHEET_CAT);
      var vals = cs.getRange(2, 1, Math.max(1, cs.getLastRow() - 1), 2).getValues();
      var i = vals.map(function (v) { return v[0]; }).indexOf(change.category);
      var known = i >= 0 && String(vals[i][1]).toLowerCase().split(',').some(function (w) { return squash_(w) === word; });
      if (i >= 0 && !known) cs.getRange(i + 2, 2).setValue(vals[i][1] + ', ' + word);
      else if (i < 0) cs.appendRow([change.category, word]);
      // Earlier payments to the same place move to the new category too.
      var p = merchantKey_(r.party);
      rows.forEach(function (x) {
        if (x.id === r.id || x.type !== r.type || merchantKey_(x.party) !== p || x.category === change.category) return;
        if (FIXED_CATS_.indexOf(x.category) >= 0) return;
        sh.getRange(x.row, COL.Category + 1).setValue(change.category); also++;
      });
    }
    return also ? 'Updated, and ' + also + ' earlier payment' + (also > 1 ? 's' : '') + ' at ' + r.party + ' moved too' : 'Updated';
  } finally {
    lock.releaseLock();
  }
}

// ----- merchant memory (Merchants tab: exact name, money in or out, category) -----
var SHEET_MER = 'Merchants';
var FIXED_CATS_ = ['Salary', 'Refunds', 'Between my accounts', 'Credit card', 'Bank confirmation'];
function merchantKey_(s) { return squash_(s).toLowerCase(); }
function merchants_() {
  var sh = ss_().getSheetByName(SHEET_MER), out = {};
  if (!sh || sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(function (v) {
    if (v[0] && v[2]) out[(String(v[1]) === 'In' ? 'In' : 'Out') + '|' + merchantKey_(v[0])] = String(v[2]);
  });
  return out;
}
// Websites typed in the Merchants tab (column D) give a payment its brand logo on the dashboard.
function merchantLogos_() {
  var sh = ss_().getSheetByName(SHEET_MER), out = {};
  if (!sh || sh.getLastRow() < 2 || sh.getLastColumn() < 4) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach(function (v) {
    var w = String(v[3] || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
    if (v[0] && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(w)) out[merchantKey_(v[0])] = w;
  });
  return out;
}
// ----- business list (a tab with header Name | Website, e.g. the UAE business list import) -----
// Bank names are cut short and upper-case ("CARREFOUR HYPERMARKE"), so matching is by words:
// every distinctive word of the company name must appear (or be cut short) in the payment name.
var BIZ_STOP_ = ' llc l l c fzc fze fz fzco fzllc co company est establishment trading uae dubai abu dhabi sharjah ajman br branch ltd limited group the and of for & services general ' +
  'restaurant rest restaurants cafe cafeteria coffee supermarket market hypermarket store stores shop shops center centre pharmacy clinic hospital medical station mall hotel ' +
  'international intl global middle east me gulf emirates arabia sole proprietorship smc pjsc psc ';
function bizWords_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(function (w) {
    return w.length >= 2 && !/^[a-z]?\d+[a-z]?\d*$/.test(w) && BIZ_STOP_.indexOf(' ' + w + ' ') < 0;
  });
}
function bizSheet_() {
  var all = ss_().getSheets();
  for (var i = 0; i < all.length; i++) {
    var sh = all[i];
    if (sh.getLastRow() > 1 && sh.getLastColumn() >= 2) {
      var h = sh.getRange(1, 1, 1, 2).getValues()[0];
      if (/^name$/i.test(String(h[0]).trim()) && /^website$/i.test(String(h[1]).trim())) return sh;
    }
  }
  return null;
}
function bizMatch_(party, list) {
  var pw = bizWords_(party), best = '', bestScore = 0, last = pw.length - 1;
  var raw = ' ' + String(party || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  if (!pw.length) return '';
  for (var i = 0; i < list.length; i++) {
    var cw = list[i][0];
    if (!cw.length || (cw.length === 1 && cw[0].length < 6)) continue;
    var len = 0, ok = true, first = false;
    for (var j = 0; ok && j < cw.length; j++) {
      var t = cw[j], hit = -1;
      for (var k = 0; k < pw.length; k++) {
        var p = pw[k];
        // exact word, or the bank cut the last word short by a letter or two ("COFFE" for "coffee")
        if (p === t || (k === last && p.length >= 5 && t.length - p.length <= 2 && t.indexOf(p) === 0)) { hit = k; break; }
      }
      if (hit < 0) ok = false; else { len += t.length; if (hit === 0) first = true; }
    }
    if (!ok || !first) continue;
    // longer match wins; then the company sharing more of the payment's words (incl. "clinic"); then fewer extra words
    var rw = list[i][2], shared = 0;
    for (var q = 0; q < rw.length; q++) if (raw.indexOf(' ' + rw[q] + ' ') >= 0) shared++;
    var score = len * 100 + shared * 10 - rw.length;
    if (score > bestScore) { best = list[i][1]; bestScore = score; }
  }
  return best;
}
// Website for each payment name from the business list; results are remembered (script properties)
// so the big list is read only when a new name turns up.
function bizLogos_(parties) {
  var props = PropertiesService.getScriptProperties(), out = {}, need = [];
  parties.forEach(function (p) {
    var k = merchantKey_(p); if (!k || out[k] !== undefined) return;
    var v = props.getProperty('biz:' + k);
    if (v === null) need.push(k); else out[k] = v;
  });
  if (!need.length) return strip_(out);
  var sh = bizSheet_();
  if (!sh) return strip_(out); // no list yet: try again next time
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues(), list = [];
  vals.forEach(function (v) {
    var w = String(v[1] || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (v[0] && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(w)) list.push([bizWords_(v[0]), w, String(v[0]).toLowerCase().split(/[^a-z0-9]+/).filter(String)]);
  });
  var save = {};
  need.forEach(function (k) { out[k] = bizMatch_(k, list); save['biz:' + k] = out[k]; });
  props.setProperties(save);
  return strip_(out);
}
function strip_(o) { var r = {}; for (var k in o) if (o[k]) r[k] = o[k]; return r; }

function merchantCategory_(tx) {
  if (!tx.party || (tx.type !== 'In' && tx.type !== 'Out') || tx.kind === 'salary' || tx.kind === 'refund') return '';
  return merchants_()[tx.type + '|' + merchantKey_(tx.party)] || '';
}
function rememberMerchant_(party, type, category) {
  var ss = ss_(), sh = ss.getSheetByName(SHEET_MER);
  if (!sh) {
    sh = ss.insertSheet(SHEET_MER);
    sh.getRange(1, 1, 1, 3).setValues([['Merchant or person (exact name)', 'Money in or out', 'Always use category']]).setFontWeight('bold');
    sh.setFrozenRows(1); sh.setColumnWidth(1, 280); sh.setColumnWidth(3, 200);
  }
  var n = sh.getLastRow(), k = merchantKey_(party);
  var vals = n > 1 ? sh.getRange(2, 1, n - 1, 2).getValues() : [];
  for (var i = 0; i < vals.length; i++) {
    if (merchantKey_(vals[i][0]) === k && String(vals[i][1]) === type) { sh.getRange(i + 2, 3).setValue(category); return; }
  }
  sh.appendRow([party, type, category]);
}

// A cash entry for an earlier day is saved at noon of that day; today (or no date) keeps the current time.
function manualTime_(date) {
  var m = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || date >= dayKey_(Date.now())) return 0;
  var t = Utilities.parseDate(date + ' 12:00', TZ, 'yyyy-MM-dd HH:mm').getTime();
  return isNaN(t) ? 0 : t;
}

// Adds the Family category to the Categories tab once (no merchant words: pick it by hand or via Merchants).
function familyOnce_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('FAMILY_V') === '1') return;
  var cs = ss_().getSheetByName(SHEET_CAT);
  var names = cs.getLastRow() > 1 ? cs.getRange(2, 1, cs.getLastRow() - 1, 1).getValues().map(function (v) { return String(v[0]); }) : [];
  if (names.indexOf('Family') < 0) {
    var at = names.indexOf('Other');
    if (at >= 0) { cs.insertRowBefore(at + 2); cs.getRange(at + 2, 1, 1, 2).setValues([['Family', '']]); }
    else cs.appendRow(['Family', '']);
  }
  props.setProperty('FAMILY_V', '1');
}

// One-time upgrades for sheets made with an older version. Each runs once, in order (FIX_V).
// v1: Investments category and a Website column in Merchants (for logos).
function fixesOnce_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('FIX_V') === '1') return;
  var ss = ss_(), cs = ss.getSheetByName(SHEET_CAT);
  var names = cs.getLastRow() > 1 ? cs.getRange(2, 1, cs.getLastRow() - 1, 1).getValues().map(function (v) { return String(v[0]); }) : [];
  if (names.indexOf('Investments') < 0) {
    var inv = DEFAULT_RULES.filter(function (r) { return r[0] === 'Investments'; })[0];
    var at = names.indexOf('Other');
    if (at >= 0) { cs.insertRowBefore(at + 2); cs.getRange(at + 2, 1, 1, 2).setValues([inv]); } else cs.appendRow(inv);
  }
  var ms = ss.getSheetByName(SHEET_MER);
  ms.getRange(1, 4).setValue('Website (for the logo, e.g. adnoc.ae)').setFontWeight('bold'); ms.setColumnWidth(4, 230);
  props.setProperty('FIX_V', '1');
}
// v2: Transfers and Bank fees are retired as categories: drop their rows from the Categories tab
// and move any payment still using them (In -> From people / Money in, Out -> To people / Other).
function fixes2_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('FIX_V') !== '1') return;
  var ss = ss_(), cs = ss.getSheetByName(SHEET_CAT);
  for (var i = cs.getLastRow(); i >= 2; i--) {
    var n = String(cs.getRange(i, 1).getValue());
    if (n === 'Transfers' || n === 'Bank fees') cs.deleteRow(i);
  }
  var tx = ss.getSheetByName(SHEET_TX);
  readRows_(tx).forEach(function (r) {
    if (r.category !== 'Transfers' && r.category !== 'Bank fees') return;
    var c = r.type === 'In' ? (r.party ? 'From people' : 'Money in') : (r.category === 'Bank fees' ? 'Other' : 'To people');
    tx.getRange(r.row, COL.Category + 1).setValue(c);
  });
  var bs = ss.getSheetByName('Budgets');
  if (bs) for (var j = bs.getLastRow(); j >= 2; j--) { var b = String(bs.getRange(j, 1).getValue()); if (b === 'Transfers' || b === 'Bank fees') bs.deleteRow(j); }
  props.setProperty('FIX_V', '2');
}
// v3: "Home utilities" category (kitchen gas etc.) placed before Fuel so "lpg" wins over "adnoc";
// LPG refills filed under Fuel or Bills & phone move there.
function fixes3_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('FIX_V') !== '2') return;
  var ss = ss_(), cs = ss.getSheetByName(SHEET_CAT);
  var names = cs.getLastRow() > 1 ? cs.getRange(2, 1, cs.getLastRow() - 1, 1).getValues().map(function (v) { return String(v[0]); }) : [];
  if (names.indexOf('Home utilities') < 0) {
    var at = names.indexOf('Fuel'), row = at >= 0 ? at + 2 : cs.getLastRow() + 1;
    cs.insertRowBefore(row); cs.getRange(row, 1, 1, 2).setValues([['Home utilities', 'lpg, gas cylinder, cooking gas']]);
  }
  var tx = ss.getSheetByName(SHEET_TX);
  readRows_(tx).forEach(function (r) {
    if (/lpg/i.test(String(r.party)) && r.type === 'Out' && (r.category === 'Bills & phone' || r.category === 'Fuel')) tx.getRange(r.row, COL.Category + 1).setValue('Home utilities');
  });
  props.setProperty('FIX_V', '3');
}
// v4, v5: nothing to do in the public version (kept so the numbering matches).
function fixes4_() { var p = PropertiesService.getScriptProperties(); if (p.getProperty('FIX_V') === '3') p.setProperty('FIX_V', '4'); }
function fixes5_() { var p = PropertiesService.getScriptProperties(); if (p.getProperty('FIX_V') === '4') p.setProperty('FIX_V', '5'); }
// v6: a "Cash" category used for money put aside is renamed "Saving" (payments and budget).
// ATM withdrawals the bank reports (kind "cash") keep the automatic "Cash" label.
function fixes6_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('FIX_V') !== '5') return;
  var ss = ss_(), tx = ss.getSheetByName(SHEET_TX);
  readRows_(tx).forEach(function (r) { if (r.category === 'Cash' && r.kind !== 'cash') tx.getRange(r.row, COL.Category + 1).setValue('Saving'); });
  var bs = ss.getSheetByName('Budgets');
  if (bs && bs.getLastRow() > 1) {
    var v = bs.getRange(2, 1, bs.getLastRow() - 1, 1).getValues();
    v.forEach(function (x, i) { if (String(x[0]) === 'Cash') bs.getRange(i + 2, 1).setValue('Saving'); });
  }
  props.setProperty('FIX_V', '6');
}

// v7: card payments saved before trxDate_ existed get the time the bank wrote in the SMS.
function fixes7_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('FIX_V') !== '6') return;
  var tx = ss_().getSheetByName(SHEET_TX);
  readRows_(tx).forEach(function (r) {
    if (r.source !== 'sms') return;
    var m = String(r.text || '').match(/Trx\.?\s*Date:?\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})/i);
    if (!m) return;
    var y = +m[3]; if (y < 100) y += 2000;
    var t = Date.UTC(y, +m[2] - 1, +m[1], +m[4] - 4, +m[5]);
    if (Math.abs(t - r.time) > 2 * 60000) tx.getRange(r.row, COL.Time + 1).setValue(new Date(t));
  });
  props.setProperty('FIX_V', '7');
}

// v8: nothing to do in the public version (kept so the numbering matches).
function fixes8_() { var p = PropertiesService.getScriptProperties(); if (p.getProperty('FIX_V') === '7') p.setProperty('FIX_V', '8'); }
// v9: "Smiles Food" is the Smiles app (smiles.ae) food delivery: remember it as Food with the Smiles logo.
function fixes9_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('FIX_V') !== '8') return;
  var ms = ss_().getSheetByName(SHEET_MER), n = ms.getLastRow(), found = false;
  var vals = n > 1 ? ms.getRange(2, 1, n - 1, 1).getValues() : [];
  vals.forEach(function (v, i) { if (merchantKey_(v[0]) === 'smiles food') { ms.getRange(i + 2, 4).setValue('smiles.ae'); found = true; } });
  if (!found) ms.appendRow(['Smiles Food', 'Out', 'Food', 'smiles.ae']);
  props.setProperty('FIX_V', '9');
}

// ===================== Email alerts (Gmail) =====================
// Sent from your own Google account to itself; the Gmail app on your phone shows them as notifications.
// Turned on/off and tuned in the Settings tab (set an amount to 0, or the evening summary to "no", to stop one).
function settingVal_(re, label, dflt) {
  var set = ss_().getSheetByName(SHEET_SET), n = set.getLastRow();
  var vals = n ? set.getRange(1, 1, n, 2).getValues() : [];
  for (var i = 0; i < vals.length; i++) if (re.test(String(vals[i][0]))) return vals[i][1];
  set.appendRow([label, dflt]);
  return dflt;
}
function alertBig_() { return parseFloat(settingVal_(/^email me for a payment over/i, 'Email me for a payment over (AED, 0 = off)', 500)) || 0; }
function alertLow_() { return parseFloat(settingVal_(/^email me when left until payday/i, 'Email me when left until payday drops below (AED, 0 = off)', 500)) || 0; }
function alertEvening_() { return !/^(no|off|0|false)$/i.test(String(settingVal_(/^evening summary email/i, 'Evening summary email at 9 pm (yes/no)', 'yes')).trim()); }
function alertSalary_() { return !/^(no|off|0|false)$/i.test(String(settingVal_(/^email me when salary arrives/i, 'Email me when salary arrives (yes/no)', 'yes')).trim()); }

function dashUrl_() { try { return ScriptApp.getService().getUrl() + '?key=' + key_(); } catch (e) { return ''; } }
function mail_(subject, lines) {
  var url = dashUrl_(), esc = function (x) { return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;'); };
  var html = '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1d2420">' +
    lines.map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('') +
    (url ? '<p style="margin-top:14px"><a href="' + url + '" style="color:#2f8f62;font-weight:600">Open My Money</a></p>' : '') + '</div>';
  MailApp.sendEmail({ to: Session.getEffectiveUser().getEmail(), subject: subject, body: lines.join('\n') + (url ? '\n\n' + url : ''), htmlBody: html, name: 'My Money' });
}
// Where alerts go: Settings "Alerts go to (calendar / email / both)". Calendar alerts are short events on a
// "My Money" calendar starting two minutes from now (time for the phone to sync) with a pop-up at start, so the iPhone shows a notification.
function alertWhere_() { var v = String(settingVal_(/^alerts go to/i, 'Alerts go to (calendar / email / both)', 'calendar')).toLowerCase(); return { cal: !/^email/.test(v), mail: /email|both/.test(v) }; }
function moneyCal_() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('CAL_ID'), cal = id ? CalendarApp.getCalendarById(id) : null;
  if (!cal) {
    cal = CalendarApp.getCalendarsByName('My Money')[0] || CalendarApp.createCalendar('My Money', { color: CalendarApp.Color.GREEN, summary: 'Alerts from the My Money dashboard' });
    props.setProperty('CAL_ID', cal.getId());
  }
  return cal;
}
function calAlert_(title, lines) {
  var url = dashUrl_(), start = new Date(Date.now() + 2 * 60000), end = new Date(start.getTime() + 10 * 60000);
  var ev = moneyCal_().createEvent(title, start, end, { description: lines.join('\n') + (url ? '\n\nOpen My Money: ' + url : '') });
  ev.removeAllReminders(); ev.addPopupReminder(0);
}
function notify_(title, lines) {
  var w = alertWhere_();
  if (w.cal) { try { calAlert_(title, lines); } catch (e) { console.error(e); w.mail = true; } } // calendar failed -> email instead
  if (w.mail) mail_(title, lines);
}
function leftLine_(per) {
  if (!per || per.none) return '';
  return 'Left until payday: AED ' + fmt_(per.left) + (per.daysLeft > 0 ? ' (AED ' + fmt_(Math.max(0, per.perDay)) + '/day for ' + per.daysLeft + ' days)' : '');
}

// Called once for each newly saved payment (not for Wallet/SMS merges or skipped duplicates).
function alertsFor_(tx) {
  if (tx.currency !== 'AED' || Math.abs(Date.now() - tx.time) > 2 * 86400000) return; // old payments added by hand don't alert
  var rows = null, per = null, getPer = function () { if (!per) { rows = readRows_(ss_().getSheetByName(SHEET_TX)); per = period_(rows); } return per; };
  var who = tx.party ? ' at ' + tx.party : '';
  if (tx.type === 'In' && tx.category === 'Salary' && alertSalary_()) {
    notify_('Salary arrived: AED ' + fmt_(tx.amount), ['Your salary of AED ' + fmt_(tx.amount) + ' has arrived.', leftLine_(getPer())].filter(String));
  }
  if (tx.type !== 'Out' || SET_ASIDE.indexOf(tx.category) >= 0) return;
  var big = alertBig_();
  if (big > 0 && tx.amount >= big) {
    notify_('Big payment: AED ' + fmt_(tx.amount) + who, ['You paid AED ' + fmt_(tx.amount) + who + ' (' + (tx.category || 'Other') + ').', leftLine_(getPer())].filter(String));
  }
  var low = alertLow_();
  if (low > 0) {
    var p = getPer(), props = PropertiesService.getScriptProperties();
    if (!p.none && p.left < low && props.getProperty('LOW_WARNED') !== p.start) {
      props.setProperty('LOW_WARNED', p.start); // once per pay period
      notify_('Low money: AED ' + fmt_(p.left) + ' left until payday', ['Left until payday is now under AED ' + fmt_(low) + '.', leftLine_(p), 'Last payment: AED ' + fmt_(tx.amount) + who + '.'].filter(String));
    }
  }
}

// Daily trigger, ~9 pm Dubai time.
function eveningSummary() {
  if (!alertEvening_()) return;
  var text = dailySummary_(), first = text.split('\n')[0];
  notify_('My Money · ' + first, text.split('\n'));
}
// v66: create the evening trigger and the Settings rows, and send one confirmation email.
function alertsOnce_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('ALERTS_V') === '1') return;
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'eveningSummary') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('eveningSummary').timeBased().everyDays(1).atHour(21).inTimezone(TZ).create();
  var big = alertBig_(), low = alertLow_(); alertEvening_(); alertSalary_();
  mail_('My Money email alerts are on', ['You will get an email:',
    '• every evening around 9 pm with the day\'s summary,',
    '• for any payment of AED ' + fmt_(big) + ' or more,',
    '• when your salary arrives,',
    '• once per pay period if left until payday drops below AED ' + fmt_(low) + '.',
    'Change the amounts, or turn any of these off, in the Settings tab of your My Money sheet.']);
  props.setProperty('ALERTS_V', '1');
}

// v67: alerts also go to Google Calendar (the default: calendar only). Creates the "My Money" calendar and
// one test event so the iPhone shows a pop-up.
function calendarOnce_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('ALERTS_V') !== '1') return;
  alertWhere_();
  calAlert_('My Money alerts are on your calendar', ['Alerts now pop up here on your calendar: the evening summary at 9 pm, payments of AED ' + fmt_(alertBig_()) + ' or more, salary arrived, and low money before payday.',
    'Change this in the Settings tab of your My Money sheet ("Alerts go to": calendar, email or both).']);
  props.setProperty('ALERTS_V', '2');
}

// ===================== Side contracts =====================
// Extra paid work outside the salary (e.g. a teaching-load contract). The Contracts tab holds each
// contract; its payments are ordinary money-in rows (category "Side income") linked by transaction ID.
var SHEET_CON = 'Contracts', LAST_ID_ = '';
function conSheet_() {
  var ss = ss_(), sh = ss.getSheetByName(SHEET_CON);
  if (!sh) {
    sh = ss.insertSheet(SHEET_CON);
    sh.getRange(1, 1, 1, 8).setValues([['ID', 'Name', 'Total (AED)', 'Start', 'End', 'Paid', 'Payments (transaction IDs)', 'Note']]).setFontWeight('bold');
    sh.setFrozenRows(1); sh.setColumnWidth(2, 260); sh.setColumnWidth(7, 220); sh.setColumnWidth(8, 260);
  }
  return sh;
}
function dateKey_(v) { return v instanceof Date ? dayKey_(v.getTime()) : String(v || '').slice(0, 10); }
function contracts_(rows) {
  var sh = ss_().getSheetByName(SHEET_CON);
  if (!sh || sh.getLastRow() < 2) return [];
  var byId = {}; rows.forEach(function (r) { byId[r.id] = r; });
  return sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues().filter(function (v) { return v[0]; }).map(function (v) {
    var pays = String(v[6] || '').split(',').map(function (x) { return x.trim(); }).filter(function (id) { return byId[id]; })
      .map(function (id) { var r = byId[id]; return { id: id, day: r.day, amount: r.amount }; });
    var got = pays.reduce(function (t, p) { return t + p.amount; }, 0);
    return { id: String(v[0]), name: String(v[1]), total: Number(v[2]) || 0, start: dateKey_(v[3]), end: dateKey_(v[4]),
      paid: String(v[5]) === 'monthly' ? 'monthly' : 'end', payments: pays, received: Math.round(got * 100) / 100, note: String(v[7] || '') };
  });
}
// Recent money in that is not yet linked to a contract: the choices when a contract payment lands.
function incoming_(rows) {
  var sh = ss_().getSheetByName(SHEET_CON), linked = {};
  if (sh && sh.getLastRow() > 1) sh.getRange(2, 7, sh.getLastRow() - 1, 1).getValues().forEach(function (v) {
    String(v[0] || '').split(',').forEach(function (id) { if (id.trim()) linked[id.trim()] = 1; });
  });
  var from = dayKey_(Date.now() - 120 * 86400000);
  return rows.filter(function (r) { return r.type === 'In' && r.currency === 'AED' && r.day >= from && !linked[r.id]; })
    .sort(function (a, b) { return b.time - a.time; }).slice(0, 25)
    .map(function (r) { return { id: r.id, day: r.day, amount: r.amount, party: r.party || '', category: r.category, bank: r.bank }; });
}
function addContract(key, c) {
  if (key !== key_()) throw new Error('Not allowed');
  var total = parseFloat(c && c.total);
  if (!c || !String(c.name || '').trim()) throw new Error('Give the contract a name');
  if (!(total > 0)) throw new Error('Enter the total amount');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(c.end || '') || c.end < c.start) throw new Error('Check the start and end dates');
  var sh = conSheet_(), id = Utilities.getUuid().slice(0, 8);
  sh.appendRow([id, String(c.name).trim().slice(0, 120), total, c.start, c.end, c.paid === 'monthly' ? 'monthly' : 'end', '', String(c.note || '').slice(0, 500)]);
  sh.getRange(sh.getLastRow(), 4, 1, 2).setNumberFormat('yyyy-mm-dd');
  return id;
}
function removeContract(key, cid) {
  if (key !== key_()) throw new Error('Not allowed');
  var sh = ss_().getSheetByName(SHEET_CON); if (!sh) return 0;
  for (var i = sh.getLastRow(); i >= 2; i--) if (String(sh.getRange(i, 1).getValue()) === String(cid)) { sh.deleteRow(i); return 1; }
  return 0;
}
// Links a payment to a contract: an existing money-in row (p.txId) becomes "Side income",
// or a new money-in row is added by hand (p.amount, p.date). Returns the transaction ID.
function contractPayment(key, cid, p) {
  if (key !== key_()) throw new Error('Not allowed');
  var sh = ss_().getSheetByName(SHEET_CON); if (!sh) throw new Error('No contracts yet');
  var row = 0, vals = sh.getRange(2, 1, Math.max(1, sh.getLastRow() - 1), 7).getValues();
  for (var i = 0; i < vals.length; i++) if (String(vals[i][0]) === String(cid)) { row = i + 2; break; }
  if (!row) throw new Error('Contract not found');
  var name = String(vals[row - 2][1]), txId = '';
  var tx = ss_().getSheetByName(SHEET_TX);
  if (p && p.txId) {
    var r = readRows_(tx).filter(function (x) { return x.id === String(p.txId); })[0];
    if (!r || r.type !== 'In') throw new Error('That payment was not found');
    tx.getRange(r.row, COL.Category + 1).setValue('Side income');
    if (!r.note) tx.getRange(r.row, COL.Note + 1).setValue(name);
    txId = r.id;
  } else {
    var a = parseFloat(p && p.amount);
    if (!(a > 0)) throw new Error('Enter the amount');
    LAST_ID_ = '';
    var msg = ingest_({ source: 'manual', type: 'In', amount: a, party: name, category: 'Side income', date: p.date, bank: 'Added by hand', note: p.note || '' });
    if (!LAST_ID_) throw new Error(msg);
    txId = LAST_ID_;
  }
  var cell = sh.getRange(row, 7), cur = String(cell.getValue() || '');
  cell.setValue(cur ? cur + ',' + txId : txId);
  return txId;
}

function addManual(key, entry) {
  if (key !== key_()) throw new Error('Not allowed');
  entry.source = 'manual';
  return ingest_(entry);
}

// ===================== Overview tab =====================
// Summary tables built from formulas (they update by themselves as rows arrive) plus charts.
var OVERVIEW_VERSION = '4'; // 3: Investments and Saving shown as set aside, not spent
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
  // Spending leaves out money set aside (Investments, Saving), the same as the dashboard.
  var OUTALL = T + '$C:$C,"Out",' + T + '$F:$F,"AED"', IN = T + '$C:$C,"In",' + T + '$F:$F,"AED"';
  var OUT = OUTALL + SET_ASIDE.map(function (c) { return ',' + T + '$J:$J,"<>' + c + '"'; }).join('');
  function asideSum(from, to) { return '=' + SET_ASIDE.map(function (c) { return sumifs(OUTALL + ',' + T + '$J:$J,"' + c + '"', from, to).slice(1); }).join('+'); }
  var NOTASIDE = SET_ASIDE.map(function (c) { return ' and J <> \'' + c + '\''; }).join('');
  var MS = 'EOMONTH(TODAY(),-1)+1', ME = 'EOMONTH(TODAY(),0)+1';
  function sumifs(kind, from, to) { return '=SUMIFS(' + T + '$E:$E,' + kind + ',' + T + '$B:$B,">="&' + from + ',' + T + '$B:$B,"<"&' + to + ')'; }

  sh.getRange('A1').setValue('My Money overview').setFontSize(18).setFontWeight('bold');
  sh.getRange('A2').setValue('Updates by itself as transactions arrive. Amounts in AED; transfers between your own accounts are left out.').setFontColor('#5D6B63');

  // Key figures
  var k = [
    ['This month', ''],
    ['Spent', sumifs(OUT, MS, ME)],
    ['Set aside (' + SET_ASIDE.join(', ') + ')', asideSum(MS, ME)],
    ['Received', sumifs(IN, MS, ME)],
    ['Net (received − spent)', '=B7-B5'],
    ['Spent today', sumifs(OUT, 'TODAY()', 'TODAY()+1')],
    ['Payments this month', '=COUNTIFS(' + OUT + ',' + T + '$B:$B,">="&' + MS + ',' + T + '$B:$B,"<"&' + ME + ')']
  ];
  sh.getRange(4, 1, k.length, 2).setValues(k);
  sh.getRange('A4').setFontWeight('bold');
  var row = 4 + k.length;
  var cards = cards_();
  Object.keys(cards).forEach(function (c) {
    var H = T + '$H$2:$H', K = T + '$K$2:$K', hasBal = '((' + H + '="*' + c + '")*(' + K + '<>""))';
    // Last card balance + card payments saved after it (payment SMS carry no balance).
    var avail = '=IFERROR(ARRAYFORMULA(MIN(' + cards[c] + ',LOOKUP(2,1/' + hasBal + ',' + K + ')+SUMPRODUCT((' + H + '="*' + c + '")*(' + T + '$I$2:$I="Card Payment")*(ROW(' + H + ')>LOOKUP(2,1/' + hasBal + ',ROW(' + H + ')))*' + T + '$E$2:$E))),' + cards[c] + ')';
    sh.getRange(row, 1, 3, 2).setValues([
      ['Card *' + c + ' available', avail],
      ['Card *' + c + ' used', '=' + cards[c] + '-B' + row],
      ['Card *' + c + ' limit', cards[c]]]);
    row += 3;
  });
  sh.getRange(5, 2, row - 5, 1).setNumberFormat('#,##0.00');
  sh.getRange(10, 2).setNumberFormat('0');

  // Spending by category, this month
  var r1 = row + 2;
  sh.getRange(r1, 1).setValue('Spending by category, this month').setFontWeight('bold');
  sh.getRange(r1 + 1, 1).setFormula('=IFERROR(QUERY(Transactions!A:O,"select J, sum(E) where C = \'Out\' and F = \'AED\'' + NOTASIDE + ' and B >= datetime \'"&TEXT(' + MS + ',"yyyy-mm-dd")&" 00:00:00\' group by J order by sum(E) desc label J \'Category\', sum(E) \'Spent\'",1),"No spending yet this month")');
  sh.getRange(r1 + 2, 2, 20, 1).setNumberFormat('#,##0.00');

  // Top places and people, this month (real shops and named people only, same rule as the dashboard)
  sh.getRange(r1, 4).setValue('Top places and people, this month').setFontWeight('bold');
  sh.getRange(r1 + 1, 4).setFormula('=IFERROR(QUERY(Transactions!A:O,"select I, count(E), sum(E) where C = \'Out\' and F = \'AED\'' + NOTASIDE + ' and I <> \'\' and lower(I) <> lower(J)' + NOT_PLACE.map(function (w) { return ' and lower(I) <> \'' + w + '\''; }).join('') + ' and B >= datetime \'"&TEXT(' + MS + ',"yyyy-mm-dd")&" 00:00:00\' group by I order by sum(E) desc limit 10 label I \'Where / who\', count(E) \'Times\', sum(E) \'Spent\'",1),"")');
  sh.getRange(r1 + 2, 6, 10, 1).setNumberFormat('#,##0.00');

  // Money in vs out, last 12 months
  var r2 = r1 + 24;
  sh.getRange(r2, 1).setValue('Money in vs spent, last 12 months').setFontWeight('bold');
  var m = [['Month', 'Money in', 'Spent']];
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
  chart(Charts.ChartType.COLUMN, sh.getRange(r2 + 1, 1, 13, 3), 'Money in vs spent, last 12 months', [green, red], 18);
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
  if (map && map.__salary !== undefined) { if (parseFloat(map.__salary) > 0) planSalary_(0, parseFloat(map.__salary)); delete map.__salary; }
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
    var k = r.day;
    // Rows added by hand (old salary, side income, bills marked paid) don't start tracking.
    if (r.source !== 'manual' && (!first || k < first)) first = k;
    if (r.type === 'Out' && r.currency === 'AED' && SET_ASIDE.indexOf(r.category) < 0) per[k] = (per[k] || 0) + r.amount;
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
  var s = { out: 0, inn: 0, nOut: 0, cats: {}, places: {}, big: [], days: {}, salary: 0, people: 0, aside: 0, asideCats: {} };
  rows.forEach(function (r) {
    if (r.currency !== 'AED' || r.day.slice(0, 7) !== mk) return;
    if (isAside_(r)) { s.aside += r.amount; s.asideCats[r.category] = (s.asideCats[r.category] || 0) + r.amount; return; }
    if (r.type === 'Out') {
      s.out += r.amount; s.nOut++;
      s.cats[r.category] = (s.cats[r.category] || 0) + r.amount;
      if (isPlace_(r.party, r.category)) { var pl = r.party; s.places[pl] = s.places[pl] || { v: 0, n: 0 }; s.places[pl].v += r.amount; s.places[pl].n++; }
      s.days[r.day] = (s.days[r.day] || 0) + r.amount;
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
    [['Money in', n0(cur.inn), green], ['Spent', n0(cur.out), red], ['Net', (net < 0 ? '−' : '+') + n0(Math.abs(net)), net < 0 ? red : green]].map(function (c) {
      return '<td width="33%" style="border-top:2px solid ' + c[2] + ';padding-top:6px;vertical-align:top"><div style="font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:' + muted + '">' + c[0] + '</div><div style="font-size:17px;' + mono + 'color:' + (c[0] === 'Net' ? c[2] : ink) + '">' + c[1] + '</div></td>';
    }).join('<td width="8"></td>') + '</tr></table></td></tr>';
  var facts = [];
  if (cur.salary) facts.push('Salary AED ' + n0(cur.salary) + (cur.salary ? ' · kept ' + Math.max(0, Math.round((cur.salary - cur.out) / cur.salary * 100)) + '%' : ''));
  if (cur.people) facts.push('From people AED ' + n0(cur.people));
  if (cur.aside) facts.push('Set aside AED ' + n0(cur.aside) + ' (' + Object.keys(cur.asideCats).map(function (c) { return c + ' ' + n0(cur.asideCats[c]); }).join(', ') + ')');
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
  var over = Object.keys(budgets).filter(function (c) { return (cur.cats[c] || cur.asideCats[c] || 0) <= budgets[c]; });
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
  var plain = subject + '\nMoney in AED ' + fmt_(cur.inn) + ', spent AED ' + fmt_(cur.out) + (cur.aside ? ', set aside AED ' + fmt_(cur.aside) : '') + ', net AED ' + fmt_(net) + '\n' +
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
    out.push({ d: r.day, h: +Utilities.formatDate(new Date(r.time), TZ, 'H'), t: r.type, a: r.amount, c: r.category, p: r.party || '', w: /wallet/.test(r.source) ? 1 : 0 });
  });
  out.sort(function (a, b) { return a.d < b.d ? -1 : (a.d > b.d ? 1 : 0); });
  var st = streak_(rows);
  return { today: dayKey_(Date.now()), rows: out, other: other, budgets: budgets_(), best: st.best, current: st.current,
    logos: merchantLogos_(), blogos: bizLogos_(rows.filter(function (r) { return r.kind === 'purchase' && r.party; }).map(function (r) { return r.party; })) };
}
