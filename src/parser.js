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
  ['Rent', 'rent, landlord, ejari, real estate, property management'],
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
  // A plain "AED x was debited from your account" with no name is almost always money sent to a friend.
  if (tx.kind === 'account' && tx.type === 'Out' && !tx.party) return tx.amount <= 5 ? 'Bank fees' : 'To people';
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

if (typeof module !== 'undefined') module.exports = { personName_: personName_, parseMessage: parseMessage, categorize: categorize, reconcile: reconcile, rulesFromTable: rulesFromTable, DEFAULT_RULES: DEFAULT_RULES, isOwner: isOwner, detectBank: detectBank };
