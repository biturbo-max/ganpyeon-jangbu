/**
 * 보고서 계산 — 순수 함수만 둔다(시트 접근 없음). Node 테스트에서도 그대로 불러 쓴다.
 * 거래 객체: { id, date:'YYYY-MM-DD', kind:'INCOME'|'EXPENSE'|'ASSET', category, partner,
 *             supplyAmount, vatAmount, totalAmount, ... }
 */

var KINDS = ['INCOME', 'EXPENSE', 'ASSET'];
var KIND_LABEL = { INCOME: '수입', EXPENSE: '비용', ASSET: '고정자산매입' };

/** 부표 항목 코드 → 서식 이름. 순서가 곧 화면/인쇄 순서. */
var FORM_LINES = [
  ['L11', '(11) 매출액'], ['L12', '(12) 기타(수입)'],
  ['L15_GOODS', '상품매입'], ['L19', '(19) 재료 당기매입액'],
  ['L22', '(22) 노무비'], ['L23', '(23) 경비'],
  ['L25', '(25) 급료'], ['L26', '(26) 제세공과금'], ['L27', '(27) 임차료'],
  ['L28', '(28) 지급이자'], ['L29', '(29) 접대비'], ['L30', '(30) 기부금'],
  ['L31', '(31) 감가상각비'], ['L32', '(32) 차량유지비'], ['L33', '(33) 지급수수료'],
  ['L34', '(34) 소모품비'], ['L35', '(35) 복리후생비'], ['L36', '(36) 운반비'],
  ['L37', '(37) 광고선전비'], ['L38', '(38) 여비교통비'], ['L39', '(39) 기타(비용)'],
  ['OWN', '자체 항목 — 이름 그대로 표시, (39) 기타에 합산']
];
var INCOME_LINES = ['L11', 'L12'];

function yearOf_(date) { return Number(String(date).slice(0, 4)); }
function monthOf_(date) { return Number(String(date).slice(5, 7)); }
function num_(v) { return Number(v) || 0; }

function sumBy_(txs, field) {
  var s = 0;
  for (var i = 0; i < txs.length; i++) s += num_(txs[i][field]);
  return s;
}

/** 총수입금액 및 필요경비명세서(부표). 금액은 공급가액 기준(원본과 동일). */
function computeExpenseStatement(txs, categories, adj, year) {
  adj = adj || {};
  var map = {};
  categories.forEach(function (c) { map[c.kind + '|' + c.name] = c.formLine || ''; });

  var by = {}, unmapped = {}, own = {};
  FORM_LINES.forEach(function (l) { by[l[0]] = 0; });

  txs.forEach(function (t) {
    if (yearOf_(t.date) !== year || t.kind === 'ASSET') return;
    var line = map[t.kind + '|' + t.category];
    var ok = line && (t.kind === 'INCOME') === (INCOME_LINES.indexOf(line) >= 0);
    if (ok && line === 'OWN') {   // 서식에 칸이 없는 자체 항목: (39) 기타에 합산하고 이름별 내역을 남긴다
      by.L39 += num_(t.supplyAmount); own[t.category] = (own[t.category] || 0) + num_(t.supplyAmount); return;
    }
    if (ok) { by[line] += num_(t.supplyAmount); return; }
    var key = t.kind + '|' + t.category;
    unmapped[key] = (unmapped[key] || 0) + num_(t.supplyAmount);
  });

  var L = {};
  L.L11 = by.L11; L.L12 = by.L12; L.L13 = L.L11 + L.L12;
  L.L18 = num_(adj.L18); L.L19 = by.L19; L.L20 = num_(adj.L20);
  L.L21 = L.L18 + L.L19 - L.L20;
  L.L22 = by.L22; L.L23 = by.L23;
  L.L24 = L.L21 + L.L22 + L.L23;
  L.L14 = num_(adj.L14); L.L16 = num_(adj.L16);
  L.L15 = by.L15_GOODS + L.L24;          // 당기상품매입액 또는 제조비용(24)
  L.L17 = L.L14 + L.L15 - L.L16;
  L.L40 = 0;
  for (var n = 25; n <= 39; n++) { L['L' + n] = by['L' + n]; L.L40 += by['L' + n]; }
  L.L41 = L.L17 + L.L40;

  var warnings = Object.keys(unmapped).map(function (k) {
    var p = k.split('|');
    return { code: 'UNMAPPED_CATEGORY', kind: p[0], category: p[1], amount: unmapped[k] };
  });
  var ownItems = Object.keys(own).map(function (k) { return { category: k, amount: own[k] }; });
  return { year: year, lines: L, ownItems: ownItems, warnings: warnings };
}

/** 간편장부소득금액계산서. 장부상 금액은 반드시 부표 결과에서 가져온다. */
function computeIncomeStatement(txs, categories, adj, year) {
  adj = adj || {};
  var es = computeExpenseStatement(txs, categories, adj, year);
  var L = {};
  L.L11 = es.lines.L13;
  L.L12 = num_(adj.adjIncomeMinus); L.L13 = num_(adj.adjIncomePlus);
  L.L14 = L.L11 - L.L12 + L.L13;
  L.L15 = es.lines.L41;
  L.L16 = num_(adj.adjExpenseMinus); L.L17 = num_(adj.adjExpensePlus);
  L.L18 = L.L15 - L.L16 + L.L17;
  L.L19 = L.L14 - L.L18;
  L.L20 = num_(adj.donationExcess); L.L21 = num_(adj.donationCarryover);
  L.L22 = L.L19 + L.L20 - L.L21;
  return { year: year, lines: L, warnings: es.warnings };
}

function emptyKinds_() { return { INCOME: 0, EXPENSE: 0, ASSET: 0 }; }

/** 대시보드: 월별·전년비교·전체누계·분기·일자별. 금액은 합계(부가세 포함) 기준(원본과 동일). */
function computeDashboard(txs, year, date) {
  var monthly = [];
  for (var m = 1; m <= 12; m++) { var o = emptyKinds_(); o.month = m; monthly.push(o); }
  var yearTotal = emptyKinds_(), prev = emptyKinds_(), all = emptyKinds_();
  var day = {}, prevDayTotal = emptyKinds_();
  KINDS.forEach(function (k) { day[k] = { supply: 0, vat: 0, total: 0, rateVsPrevDay: null }; });
  var prevDate = shiftDate_(date, -1);

  txs.forEach(function (t) {
    var k = t.kind, tot = num_(t.totalAmount), y = yearOf_(t.date);
    if (!(k in all)) return;
    all[k] += tot;
    if (y === year) { monthly[monthOf_(t.date) - 1][k] += tot; yearTotal[k] += tot; }
    if (y === year - 1) prev[k] += tot;
    if (t.date === date) { day[k].supply += num_(t.supplyAmount); day[k].vat += num_(t.vatAmount); day[k].total += tot; }
    if (t.date === prevDate) prevDayTotal[k] += tot;   // 원본 버그 수정: 같은 종류끼리 비교
  });

  var diff = {}, diffRate = {}, quarterly = [];
  KINDS.forEach(function (k) {
    diff[k] = yearTotal[k] - prev[k];
    diffRate[k] = prev[k] ? diff[k] / prev[k] : null;
    if (day[k].total && prevDayTotal[k]) day[k].rateVsPrevDay = (day[k].total - prevDayTotal[k]) / prevDayTotal[k];
  });
  for (var q = 0; q < 4; q++) {
    var s = emptyKinds_(); s.quarter = q + 1;
    for (var i = q * 3; i < q * 3 + 3; i++) KINDS.forEach(function (k) { s[k] += monthly[i][k]; });
    quarterly.push(s);
  }
  return { year: year, date: date, monthly: monthly, yearTotal: yearTotal, prevYearTotal: prev,
           diff: diff, diffRate: diffRate, allTimeTotal: all, quarterly: quarterly, day: day };
}

function shiftDate_(date, days) {
  var p = String(date).split('-').map(Number);
  var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + days));
  return d.toISOString().slice(0, 10);
}

/** 월별현황: 거래구분 × 12개월. kind 생략 시 전체. */
function computeMonthly(txs, categories, year, kind) {
  var kinds = kind ? [kind] : KINDS, rows = [], idx = {};
  function row(k, name) {
    var key = k + '|' + name;
    if (!idx[key]) { idx[key] = { kind: k, category: name, months: [0,0,0,0,0,0,0,0,0,0,0,0], total: 0 }; rows.push(idx[key]); }
    return idx[key];
  }
  kinds.forEach(function (k) {
    categories.filter(function (c) { return c.kind === k && c.isActive !== false; })
      .forEach(function (c) { row(k, c.name); });
  });
  txs.forEach(function (t) {
    if (yearOf_(t.date) !== year || kinds.indexOf(t.kind) < 0) return;
    var r = row(t.kind, t.category), v = num_(t.totalAmount);
    r.months[monthOf_(t.date) - 1] += v; r.total += v;
  });
  rows.sort(function (a, b) { return kinds.indexOf(a.kind) - kinds.indexOf(b.kind); }); // 같은 종류 안의 순서는 유지
  var grand = [0,0,0,0,0,0,0,0,0,0,0,0];
  rows.forEach(function (r) { r.months.forEach(function (v, i) { grand[i] += v; }); });
  return { year: year, kind: kind || null, rows: rows, grandTotal: grand,
           grandSum: grand.reduce(function (a, b) { return a + b; }, 0) };
}

/** 거래처별현황: 기간 내 목록 + 기간 합계 + 누계(종료일까지 전체). */
function computeByPartner(txs, partner, from, to) {
  var rows = [], period = { count: 0, INCOME: 0, EXPENSE: 0, ASSET: 0 }, cum = { count: 0, INCOME: 0, EXPENSE: 0, ASSET: 0 };
  txs.forEach(function (t) {
    if (t.partner !== partner || t.date > to) return;
    cum.count++; cum[t.kind] += num_(t.totalAmount);
    if (t.date >= from) { rows.push(t); period.count++; period[t.kind] += num_(t.totalAmount); }
  });
  rows.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  return { partner: partner, from: from, to: to, rows: rows, periodSum: period, cumulativeSum: cum };
}

/** 목록 필터(내역관리·거래별현황 공용). 정렬·페이지·합계 포함. */
function filterTransactions(txs, p) {
  var q = p.q ? String(p.q).trim().toLowerCase() : '';
  var field = p.qField || 'description';
  var out = txs.filter(function (t) {
    if (p.from && t.date < p.from) return false;
    if (p.to && t.date > p.to) return false;
    if (p.kind && t.kind !== p.kind) return false;
    if (p.category && t.category !== p.category) return false;
    if (p.partner && t.partner !== p.partner) return false;
    if (p.evidence && t.evidence !== p.evidence) return false;
    if (q) {
      var v = String(t[field] || '').toLowerCase();
      if (p.exact ? v !== q : v.indexOf(q) < 0) return false;
    }
    return true;
  });
  var dir = p.sortOrder === 'asc' ? 1 : -1, key = p.sortBy || 'date';
  out.sort(function (a, b) {
    var x = a[key], y = b[key];
    if (x === y) return (seq_(a.id) - seq_(b.id)) * dir;
    return (x < y ? -1 : 1) * dir;
  });
  var sums = { supply: sumBy_(out, 'supplyAmount'), vat: sumBy_(out, 'vatAmount'), total: sumBy_(out, 'totalAmount'), byKind: {} };
  KINDS.forEach(function (k) {
    var o = out.filter(function (t) { return t.kind === k; });
    sums.byKind[k] = { count: o.length, supply: sumBy_(o, 'supplyAmount'), vat: sumBy_(o, 'vatAmount'), total: sumBy_(o, 'totalAmount') };
  });
  var pageSize = Math.min(Math.max(Number(p.pageSize) || 50, 1), 500);
  var totalPages = Math.max(1, Math.ceil(out.length / pageSize));
  var page = Math.min(Math.max(Number(p.page) || 1, 1), totalPages);
  return {
    data: out.slice((page - 1) * pageSize, page * pageSize),
    pagination: { page: page, pageSize: pageSize, totalItems: out.length, totalPages: totalPages },
    sums: sums, all: out
  };
}

function seq_(id) { return Number(String(id).replace(/\D/g, '')) || 0; }

/** 부가세: 별도면 공급가액×10% 원 미만 절사(원본 동작), 없음이면 0. 직접 입력값이 있으면 존중. */
function computeVat(supplyAmount, vatMode, vatAmount) {
  if (vatAmount !== undefined && vatAmount !== null && vatAmount !== '') return Number(vatAmount);
  return vatMode === 'SEPARATE' ? Math.floor(Number(supplyAmount) * 0.1) : 0;
}

if (typeof module !== 'undefined') {
  module.exports = { computeExpenseStatement: computeExpenseStatement, computeIncomeStatement: computeIncomeStatement,
    computeDashboard: computeDashboard, computeMonthly: computeMonthly, computeByPartner: computeByPartner,
    filterTransactions: filterTransactions, computeVat: computeVat, FORM_LINES: FORM_LINES };
}
