/**
 * 간편장부 웹앱 — 화면 제공(doGet) + API(api) + 시트 읽기/쓰기.
 * 배포: 웹 앱, 실행 사용자 = 나, 액세스 = 나만 (appsscript.json 참고)
 * 모든 응답: { ok:true, data } | { ok:false, error:{ code, message, details? } }
 */

/** 스프레드시트에 붙인(확장 프로그램 › Apps Script) 스크립트면 비워 둔다.
 *  독립 실행형 프로젝트(script.google.com › 새 프로젝트)면 장부 스프레드시트 ID를 넣는다.
 *  ID = 스프레드시트 주소의 /d/ 와 /edit 사이 문자열 */
var SHEET_ID = '';

var HEADERS = {
  transactions: ['id', 'date', 'kind', 'category', 'description', 'partner', 'supplyAmount',
    'vatAmount', 'totalAmount', 'evidence', 'memo', 'vatMode', 'createdAt', 'updatedAt', 'requestId'],
  categories: ['kind', 'name', 'formLine', 'sortOrder', 'isActive'],
  partners: ['id', 'name', 'owner', 'bizNo', 'contact', 'phone', 'memo'],
  settings: ['key', 'value'],
  adjustments: ['year', 'L14', 'L16', 'L18', 'L20', 'adjIncomeMinus', 'adjIncomePlus',
    'adjExpenseMinus', 'adjExpensePlus', 'donationExcess', 'donationCarryover']
};
var NUMERIC = { supplyAmount: 1, vatAmount: 1, totalAmount: 1, sortOrder: 1, year: 1,
  L14: 1, L16: 1, L18: 1, L20: 1, adjIncomeMinus: 1, adjIncomePlus: 1, adjExpenseMinus: 1,
  adjExpensePlus: 1, donationExcess: 1, donationCarryover: 1 };
var DEFAULT_EVIDENCE = ['세금계산서', '계산서', '신용카드', '현금영수증', '간이영수증', '계좌이체', '현금'];
var PROFILE_KEYS = ['ownerName', 'birthDate', 'address', 'phone', 'bizName', 'bizNo', 'bizAddress',
  'industry', 'industryCode', 'vatDefault.INCOME', 'vatDefault.EXPENSE', 'vatDefault.ASSET'];

// ───────────────────────── 진입점 ─────────────────────────

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('간편장부')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** 화면에서 google.script.run.api(action, payload)로 부르는 유일한 함수 */
function api(action, payload) {
  try {
    var fn = ACTIONS[action];
    if (!fn) throw apiError_('NOT_FOUND', '알 수 없는 요청입니다: ' + action);
    return { ok: true, data: fn(payload || {}) };
  } catch (e) {
    if (e.apiCode) return { ok: false, error: { code: e.apiCode, message: e.message, details: e.details } };
    console.error(action, e && e.stack || e);
    return { ok: false, error: { code: 'INTERNAL', message: '일시적인 오류입니다. 잠시 후 다시 시도해 주세요.' } };
  }
}

var ACTIONS = {
  'init': function () {
    return { settings: getSettings_(), categories: readCategories_().map(strip_), partners: readTable_('partners').map(strip_),
      evidence: evidence_(), formLines: FORM_LINES, today: today_() };
  },

  // 거래
  'transactions.list': function (p) {
    checkRange_(p);
    var r = filterTransactions(readTx_(), p);
    delete r.all;
    r.data = r.data.map(strip_);
    return r;
  },
  'transactions.get': function (p) { return strip_(findTx_(p.id)); },
  'transactions.create': function (p) { return withLock_(function () { return createTx_(p); }); },
  'transactions.update': function (p) { return withLock_(function () { return updateTx_(p); }); },
  'transactions.delete': function (p) {
    return withLock_(function () {
      var t = readTx_().filter(function (x) { return x.id === p.id; })[0];
      if (t) sheet_('transactions').deleteRow(t._row);
      return { deleted: !!t };
    });
  },
  'transactions.bulkDelete': function (p) {
    var ids = (p.ids || []).slice(0, 500);
    return withLock_(function () {
      var set = {}; ids.forEach(function (id) { set[id] = 1; });
      var rows = readTx_().filter(function (t) { return set[t.id]; }).map(function (t) { return t._row; });
      deleteRows_('transactions', rows);
      return { deletedCount: rows.length };
    });
  },

  // 거래처
  'partners.list': function () { return readTable_('partners').map(strip_); },
  'partners.create': function (p) { return withLock_(function () { return savePartner_(p, true); }); },
  'partners.update': function (p) { return withLock_(function () { return savePartner_(p, false); }); },
  'partners.delete': function (p) {
    return withLock_(function () {
      var x = readTable_('partners').filter(function (r) { return r.id === p.id; })[0];
      if (x) sheet_('partners').deleteRow(x._row);
      return { deleted: !!x };
    });
  },

  // 거래구분
  'categories.list': function (p) {
    return readCategories_().filter(function (c) { return !p.kind || c.kind === p.kind; }).map(strip_);
  },
  'categories.create': function (p) { return withLock_(function () { return createCategory_(p); }); },
  'categories.update': function (p) { return withLock_(function () { return updateCategory_(p); }); },

  // 설정·세무조정
  'settings.get': function () { return getSettings_(); },
  'settings.update': function (p) {
    return withLock_(function () {
      var bad = {};
      Object.keys(p).forEach(function (k) {
        if (PROFILE_KEYS.indexOf(k) < 0) bad[k] = '변경할 수 없는 항목입니다.';
        else if (k.indexOf('vatDefault.') === 0 && ['SEPARATE', 'NONE'].indexOf(p[k]) < 0) bad[k] = '별도 또는 없음을 선택해 주세요.';
      });
      if (Object.keys(bad).length) throw apiError_('VALIDATION_ERROR', '설정값을 확인해 주세요.', { fields: bad });
      Object.keys(p).forEach(function (k) { setSetting_(k, text_(p[k], 200)); });
      return getSettings_();
    });
  },
  'adjustments.get': function (p) { return getAdjustments_(year_(p.year)); },
  'adjustments.put': function (p) { return withLock_(function () { return putAdjustments_(p); }); },

  // 보고서 (매번 계산)
  'reports.dashboard': function (p) {
    var date = p.date || today_();
    if (!isDate_(date)) throw apiError_('VALIDATION_ERROR', "일자를 날짜형식('YYYY-MM-DD')으로 입력해 주세요.");
    return computeDashboard(readTx_(), year_(p.year), date);
  },
  'reports.monthly': function (p) { return computeMonthly(readTx_(), readCategories_(), year_(p.year), kind_(p.kind, true)); },
  'reports.byKind': function (p) {
    if (!kind_(p.kind, true)) throw apiError_('VALIDATION_ERROR', '거래종류를 선택해 주세요.');
    return ACTIONS['transactions.list'](p);
  },
  'reports.byPartner': function (p) {
    if (!p.partner) throw apiError_('VALIDATION_ERROR', '거래처를 선택해 주세요.');
    checkRange_(p, true);
    var r = computeByPartner(readTx_(), String(p.partner), p.from, p.to);
    r.rows = r.rows.map(strip_);
    return r;
  },
  'reports.expenseStatement': function (p) { return statement_(p, computeExpenseStatement); },
  'reports.incomeStatement': function (p) { return statement_(p, computeIncomeStatement); },

  'export.csv': function (p) {
    checkRange_(p);
    var rows = filterTransactions(readTx_(), p).all;
    var head = ['등록코드', '일자', '거래종류', '거래구분', '내용', '거래처', '공급가액', '부가세', '합계', '증빙', '비고'];
    var lines = [head].concat(rows.map(function (t) {
      return [t.id, t.date, KIND_LABEL[t.kind], t.category, t.description, t.partner,
        t.supplyAmount, t.vatAmount, t.totalAmount, t.evidence, t.memo];
    })).map(function (r) {
      return r.map(function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',');
    });
    return { filename: '간편장부_' + (p.from || '') + '_' + (p.to || '') + '.csv', csv: '\uFEFF' + lines.join('\r\n') };
  }
};

// ───────────────────────── 거래 ─────────────────────────

function createTx_(p) {
  var rid = text_(p.requestId, 64);
  if (!rid) throw apiError_('VALIDATION_ERROR', '요청 번호가 없습니다. 새로고침 후 다시 시도해 주세요.');
  var clean = validateTx_(p);
  var txs = readTx_();
  var dup = txs.filter(function (t) { return t.requestId === rid; })[0];
  if (dup) {  // 같은 요청의 재시도 → 이미 저장된 것을 돌려준다
    if (dup.date !== clean.date || dup.kind !== clean.kind || dup.supplyAmount !== clean.supplyAmount)
      throw apiError_('CONFLICT', '같은 요청 번호로 다른 내용이 들어왔습니다. 새로고침 후 다시 입력해 주세요.');
    return strip_(dup);
  }
  var seq = Number(getSettings_().nextSeq) || 1;
  var now = new Date().toISOString();
  clean.id = 'A' + seq + 'A';
  clean.createdAt = now; clean.updatedAt = now; clean.requestId = rid;
  appendRow_('transactions', clean);
  setSetting_('nextSeq', seq + 1);
  return clean;
}

function updateTx_(p) {
  var cur = findTx_(p.id);
  if (!p.expectedUpdatedAt || p.expectedUpdatedAt !== cur.updatedAt)
    throw apiError_('CONFLICT', '다른 창에서 이미 수정되었습니다. 새로고침 후 다시 시도해 주세요.');
  var merged = {};
  HEADERS.transactions.forEach(function (k) { merged[k] = k in p ? p[k] : cur[k]; });
  // 금액이나 부가세 방식을 바꿨는데 부가세를 직접 보내지 않았다면 다시 계산
  if (!('vatAmount' in p) && ('supplyAmount' in p || 'vatMode' in p)) merged.vatAmount = '';
  var clean = validateTx_(merged);
  clean.id = cur.id; clean.createdAt = cur.createdAt; clean.requestId = cur.requestId;
  clean.updatedAt = new Date().toISOString();
  writeRow_('transactions', cur._row, clean);
  return clean;
}

function findTx_(id) {
  var t = readTx_().filter(function (x) { return x.id === id; })[0];
  if (!t) throw apiError_('NOT_FOUND', '해당 거래를 찾을 수 없습니다.');
  return t;
}

/** 경계 검증: 원본 VBA 메시지를 그대로 쓴다. 통과하면 저장할 모양으로 정리된 객체를 돌려준다. */
function validateTx_(p) {
  var f = {}, out = {};
  out.kind = kind_(p.kind);
  if (!out.kind) f.kind = '거래종류를 선택해 주세요.';
  out.date = String(p.date || '').trim();
  if (!isDate_(out.date)) f.date = "일자를 날짜형식('YYYY-MM-DD')으로 입력해 주세요.";
  out.category = text_(p.category, 50);
  var cats = readCategories_();
  if (!out.category || !cats.some(function (c) { return c.kind === out.kind && c.name === out.category && c.isActive; }))
    f.category = '거래구분을 선택해 주세요.';
  out.supplyAmount = money_(p.supplyAmount);
  if (out.supplyAmount === null) f.supplyAmount = '금액을 숫자형식으로 입력해 주세요.';
  var vatRaw = p.vatAmount;
  if (vatRaw !== undefined && vatRaw !== null && vatRaw !== '' && money_(vatRaw) === null)
    f.vatAmount = '부가세를 숫자형식으로 입력해 주세요.';
  out.vatMode = p.vatMode || getSettings_()['vatDefault.' + out.kind] || 'NONE';
  if (['SEPARATE', 'NONE'].indexOf(out.vatMode) < 0) f.vatMode = '부가세 방식은 별도 또는 없음입니다.';
  out.evidence = text_(p.evidence, 20);
  if (out.evidence && evidence_().indexOf(out.evidence) < 0) f.evidence = '증빙을 목록에서 선택해 주세요.';
  out.description = text_(p.description, 200);
  out.partner = text_(p.partner, 100);
  out.memo = text_(p.memo, 200);
  if (Object.keys(f).length) throw apiError_('VALIDATION_ERROR', f[Object.keys(f)[0]], { fields: f });
  out.vatAmount = computeVat(out.supplyAmount, out.vatMode, vatRaw === '' || vatRaw == null ? undefined : money_(vatRaw));
  out.totalAmount = out.supplyAmount + out.vatAmount;   // 합계는 항상 서버가 계산
  return out;
}

function readTx_() { return readTable_('transactions'); }

// ───────────────────────── 거래처·거래구분·설정 ─────────────────────────

function savePartner_(p, isNew) {
  var name = text_(p.name, 100);
  if (!name) throw apiError_('VALIDATION_ERROR', '상호명을 입력해 주세요.', { fields: { name: '상호명을 입력해 주세요.' } });
  var bizNo = String(p.bizNo || '').replace(/\D/g, '');
  if (bizNo && bizNo.length !== 10) throw apiError_('VALIDATION_ERROR', '사업자번호는 숫자 10자리입니다.', { fields: { bizNo: '사업자번호는 숫자 10자리입니다.' } });
  var all = readTable_('partners');
  var cur = isNew ? null : all.filter(function (r) { return r.id === p.id; })[0];
  if (!isNew && !cur) throw apiError_('NOT_FOUND', '해당 거래처를 찾을 수 없습니다.');
  if (all.some(function (r) { return r.name === name && (!cur || r.id !== cur.id); }))
    throw apiError_('CONFLICT', '같은 상호명이 이미 있습니다.');
  var row = { id: cur ? cur.id : 'P' + ('000' + (all.reduce(function (m, r) { return Math.max(m, Number(String(r.id).slice(1)) || 0); }, 0) + 1)).slice(-4),
    name: name, owner: text_(p.owner, 50),
    bizNo: bizNo ? bizNo.slice(0, 3) + '-' + bizNo.slice(3, 5) + '-' + bizNo.slice(5) : '',
    contact: text_(p.contact, 50), phone: text_(p.phone, 30), memo: text_(p.memo, 200) };
  if (cur) writeRow_('partners', cur._row, row); else appendRow_('partners', row);
  return row;
}

function readCategories_() {
  return readTable_('categories').map(function (c) {
    return { kind: c.kind, name: String(c.name), formLine: c.formLine || '', sortOrder: Number(c.sortOrder) || 0,
      isActive: !(c.isActive === false || String(c.isActive).toUpperCase() === 'FALSE'), _row: c._row };
  }).sort(function (a, b) { return a.sortOrder - b.sortOrder; });
}

function checkFormLine_(kind, line) {
  if (kind === 'ASSET') return '';
  var codes = FORM_LINES.map(function (l) { return l[0]; });
  var ok = line && codes.indexOf(line) >= 0 && (kind === 'INCOME') === (INCOME_LINES.indexOf(line) >= 0);
  if (!ok) throw apiError_('VALIDATION_ERROR', '명세서 반영 항목을 선택해 주세요.', { fields: { formLine: '명세서 반영 항목을 선택해 주세요.' } });
  return line;
}

function createCategory_(p) {
  var kind = kind_(p.kind), name = text_(p.name, 50);
  if (!kind || !name) throw apiError_('VALIDATION_ERROR', '거래종류와 이름을 입력해 주세요.');
  var cats = readCategories_();
  if (cats.some(function (c) { return c.kind === kind && c.name === name; })) throw apiError_('CONFLICT', '이미 있는 거래구분입니다.');
  var row = { kind: kind, name: name, formLine: checkFormLine_(kind, p.formLine), isActive: true,
    sortOrder: cats.filter(function (c) { return c.kind === kind; }).reduce(function (m, c) { return Math.max(m, c.sortOrder); }, 0) + 1 };
  appendRow_('categories', row);
  return row;
}

function updateCategory_(p) {
  var kind = kind_(p.kind), cats = readCategories_();
  var cur = cats.filter(function (c) { return c.kind === kind && c.name === p.name; })[0];
  if (!cur) throw apiError_('NOT_FOUND', '해당 거래구분을 찾을 수 없습니다.');
  var row = { kind: kind, name: cur.name, formLine: 'formLine' in p ? checkFormLine_(kind, p.formLine) : cur.formLine,
    sortOrder: 'sortOrder' in p ? Number(p.sortOrder) || 0 : cur.sortOrder,
    isActive: 'isActive' in p ? !!p.isActive : cur.isActive };
  var newName = text_(p.newName, 50);
  if (newName && newName !== cur.name) {
    if (cats.some(function (c) { return c.kind === kind && c.name === newName; })) throw apiError_('CONFLICT', '이미 있는 거래구분입니다.');
    row.name = newName;
    // 과거 거래도 함께 바꾼다 (category 열만 한 번에 다시 쓴다)
    var sh = sheet_('transactions'), last = sh.getLastRow();
    if (last > 1) {
      var ci = HEADERS.transactions.indexOf('category') + 1, ki = HEADERS.transactions.indexOf('kind') + 1;
      var kinds = sh.getRange(2, ki, last - 1, 1).getValues(), col = sh.getRange(2, ci, last - 1, 1).getValues();
      col.forEach(function (r, i) { if (r[0] === cur.name && kinds[i][0] === kind) r[0] = newName; });
      sh.getRange(2, ci, last - 1, 1).setValues(col);
    }
  }
  writeRow_('categories', cur._row, row);
  return row;
}

function getSettings_() {
  var o = {};
  readTable_('settings').forEach(function (r) { o[r.key] = r.value; });
  return o;
}

function setSetting_(key, value) {
  var r = readTable_('settings').filter(function (x) { return x.key === key; })[0];
  if (r) writeRow_('settings', r._row, { key: key, value: value });
  else appendRow_('settings', { key: key, value: value });
}

function evidence_() {
  var s = getSettings_().evidenceOptions;
  return s ? String(s).split(',') : DEFAULT_EVIDENCE;
}

function getAdjustments_(year) {
  var r = readTable_('adjustments').filter(function (x) { return Number(x.year) === year; })[0];
  var o = { year: year };
  HEADERS.adjustments.slice(1).forEach(function (k) { o[k] = r ? Number(r[k]) || 0 : 0; });
  return o;
}

function putAdjustments_(p) {
  var year = year_(p.year), cur = getAdjustments_(year), bad = {};
  HEADERS.adjustments.slice(1).forEach(function (k) {
    if (!(k in p)) return;
    var v = p[k] === '' || p[k] == null ? 0 : money_(p[k]);
    if (v === null) bad[k] = '금액은 숫자로만 입력해 주세요.'; else cur[k] = v;
  });
  if (Object.keys(bad).length) throw apiError_('VALIDATION_ERROR', '금액은 숫자로만 입력해 주세요.', { fields: bad });
  var r = readTable_('adjustments').filter(function (x) { return Number(x.year) === year; })[0];
  if (r) writeRow_('adjustments', r._row, cur); else appendRow_('adjustments', cur);
  return cur;
}

function statement_(p, fn) {
  var year = year_(p.year), s = getSettings_();
  var r = fn(readTx_(), readCategories_(), getAdjustments_(year), year);
  r.header = { year: year, periodFrom: year + '-01-01', periodTo: year + '-12-31',
    ownerName: s.ownerName || '', birthDate: s.birthDate || '', address: s.address || '', phone: s.phone || '',
    bizAddress: s.bizAddress || '', industry: s.industry || '', industryCode: s.industryCode || '', bizNo: s.bizNo || '' };
  r.adjustments = getAdjustments_(year);
  return r;
}

// ───────────────────────── 시트 접근 ─────────────────────────

function sheet_(name) {
  var ss = book_(), sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]);
    sh.setFrozenRows(1);
  }
  if (!sheet_.formatted) sheet_.formatted = {};
  if (!sheet_.formatted[name]) {   // 글자 열은 '일반 텍스트'로 고정 → 날짜·숫자로 자동 변환되지 않게
    HEADERS[name].forEach(function (k, i) {
      if (!NUMERIC[k]) sh.getRange(2, i + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
    });
    sheet_.formatted[name] = true;
  }
  return sh;
}

function book_() {
  if (!book_.ss) book_.ss = SHEET_ID ? SpreadsheetApp.openById(SHEET_ID) : SpreadsheetApp.getActive();
  return book_.ss;
}

// ponytail: 매 요청마다 시트 전체를 읽는다. 수만 행까지는 충분히 빠름, 그 이상이면 연도별 시트 분할.
function readTable_(name) {
  var sh = sheet_(name), last = sh.getLastRow(), head = HEADERS[name];
  if (last < 2) return [];
  var sheetHead = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  var idx = head.map(function (k) { return sheetHead.indexOf(k); });
  return sh.getRange(2, 1, last - 1, sheetHead.length).getValues().map(function (r, i) {
    var o = { _row: i + 2 };
    head.forEach(function (k, j) { o[k] = idx[j] < 0 ? '' : cell_(k, r[idx[j]]); });
    return o;
  }).filter(function (o) { return o[head[0]] !== ''; });
}

function cell_(key, v) {
  if (v instanceof Date) return key === 'date' ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : v.toISOString();
  if (NUMERIC[key]) return Number(v) || 0;
  return v === null ? '' : (typeof v === 'boolean' ? v : String(v));
}

function rowValues_(name, obj) {
  return HEADERS[name].map(function (k) {
    var v = obj[k];
    if (v === undefined || v === null) return '';
    if (typeof v === 'string' && /^[=+\-@]/.test(v)) return "'" + v;   // 수식 주입 방지
    return v;
  });
}

function appendRow_(name, obj) {
  var sh = sheet_(name);
  sh.getRange(sh.getLastRow() + 1, 1, 1, HEADERS[name].length).setValues([rowValues_(name, obj)]);
}

function writeRow_(name, row, obj) {
  sheet_(name).getRange(row, 1, 1, HEADERS[name].length).setValues([rowValues_(name, obj)]);
}

// ponytail: 행을 하나씩 지운다. 수백 건이면 몇 초 걸림, 더 많아지면 남길 행만 다시 쓰는 방식으로.
function deleteRows_(name, rows) {
  var sh = sheet_(name);
  rows.sort(function (a, b) { return b - a; }).forEach(function (r) { sh.deleteRow(r); });
}

/** 쓰기는 모두 스크립트 잠금 안에서 → 중복 확인과 추가가 한 덩어리로 실행된다. */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw apiError_('CONFLICT', '다른 저장이 진행 중입니다. 잠시 후 다시 시도해 주세요.');
  try { return fn(); } finally { SpreadsheetApp.flush(); lock.releaseLock(); }
}

// ───────────────────────── 작은 도우미 ─────────────────────────

function apiError_(code, message, details) {
  var e = new Error(message); e.apiCode = code; e.details = details; return e;
}

function strip_(o) {
  var c = {}; Object.keys(o).forEach(function (k) { if (k !== '_row') c[k] = o[k]; }); return c;
}

function text_(v, max) {
  return v == null ? '' : String(v).trim().slice(0, max);
}

function money_(v) {
  if (typeof v === 'string') v = v.replace(/[,\s원]/g, '');
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(v);
  return isFinite(n) && n >= 0 && n < 1e12 && Math.floor(n) === n ? n : null;
}

function kind_(v, optional) {
  if (!v && optional) return null;
  return KINDS.indexOf(v) >= 0 ? v : null;
}

function isDate_(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  var p = s.split('-').map(Number), d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2];
}

function year_(v) {
  var y = Number(v) || Number(today_().slice(0, 4));
  if (y < 2000 || y > 2100) throw apiError_('VALIDATION_ERROR', '연도를 확인해 주세요.');
  return y;
}

function today_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }

/** 기간은 둘 다 넣거나 둘 다 비운다(원본 규칙). required면 둘 다 필수. */
function checkRange_(p, required) {
  if (!p.from !== !p.to || (required && !p.from))
    throw apiError_('VALIDATION_ERROR', '시작일과 종료일 모두 입력해 주셔야 합니다.');
  if (p.from && (!isDate_(p.from) || !isDate_(p.to)))
    throw apiError_('VALIDATION_ERROR', "기간을 날짜형식('YYYY-MM-DD')으로 입력해 주세요.");
  if (p.from && p.from > p.to) throw apiError_('VALIDATION_ERROR', '시작일이 종료일보다 늦습니다.');
}
