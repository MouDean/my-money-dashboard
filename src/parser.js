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

if (typeof module !== 'undefined') module.exports = { personName_: personName_, parseMessage: parseMessage, categorize: categorize, reconcile: reconcile, rulesFromTable: rulesFromTable, DEFAULT_RULES: DEFAULT_RULES, isOwner: isOwner, detectBank: detectBank };
