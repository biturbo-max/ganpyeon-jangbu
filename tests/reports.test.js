// 실행: node tests/reports.test.js
const assert = require('node:assert/strict');
const R = require('../apps-script/Reports.gs');

const cats = [
  { kind: 'INCOME', name: '매출', formLine: 'L11' },
  { kind: 'INCOME', name: '기타(수입)', formLine: 'L12' },
  { kind: 'EXPENSE', name: '급료', formLine: 'L25' },
  { kind: 'EXPENSE', name: '상품매입', formLine: 'L15_GOODS' },
  { kind: 'EXPENSE', name: '재료매입', formLine: 'L19' },
  { kind: 'EXPENSE', name: '교재비', formLine: '' },          // 미매핑 → 경고
  { kind: 'ASSET', name: '가전제품', formLine: '' },
];
const t = (id, date, kind, category, supply, vat = 0, partner = '') =>
  ({ id, date, kind, category, partner, supplyAmount: supply, vatAmount: vat, totalAmount: supply + vat });
const txs = [
  t('A1A', '2025-01-10', 'INCOME', '매출', 1000000, 0, '갑'),
  t('A2A', '2025-01-10', 'INCOME', '기타(수입)', 500),
  t('A3A', '2025-02-01', 'EXPENSE', '급료', 300000),
  t('A4A', '2025-02-02', 'EXPENSE', '교재비', 40000, 0, '갑'),
  t('A5A', '2025-03-03', 'EXPENSE', '상품매입', 100000, 10000),
  t('A6A', '2025-03-04', 'EXPENSE', '재료매입', 20000),
  t('A7A', '2025-09-05', 'ASSET', '가전제품', 900000),
  t('A8A', '2024-05-05', 'INCOME', '매출', 800000, 0, '갑'),
  t('A9A', '2025-01-09', 'INCOME', '매출', 200000),
];
const adj = { L14: 5000, L16: 3000, L18: 1000, L20: 500, adjIncomePlus: 100, adjExpenseMinus: 50, donationExcess: 7 };

// 부표
const es = R.computeExpenseStatement(txs, cats, adj, 2025);
assert.equal(es.lines.L13, 1200500);                       // 매출 1,200,000 + 기타 500
assert.equal(es.lines.L21, 1000 + 20000 - 500);            // 재료비
assert.equal(es.lines.L24, 20500);
assert.equal(es.lines.L15, 100000 + 20500);                // 상품매입(공급가액) + 제조비용(24)
assert.equal(es.lines.L17, 5000 + 120500 - 3000);
assert.equal(es.lines.L40, 300000);
assert.equal(es.lines.L41, 122500 + 300000);
assert.deepEqual(es.warnings, [{ code: 'UNMAPPED_CATEGORY', kind: 'EXPENSE', category: '교재비', amount: 40000 }]);

// 계산서는 부표 결과를 그대로 써야 한다
const is = R.computeIncomeStatement(txs, cats, adj, 2025);
assert.equal(is.lines.L11, es.lines.L13);
assert.equal(is.lines.L15, es.lines.L41);
assert.equal(is.lines.L14, 1200600);
assert.equal(is.lines.L18, 422450);
assert.equal(is.lines.L22, 1200600 - 422450 + 7);

// 대시보드
const d = R.computeDashboard(txs, 2025, '2025-01-10');
assert.equal(d.monthly[0].INCOME, 1200500);
assert.equal(d.yearTotal.ASSET, 900000);
assert.equal(d.prevYearTotal.INCOME, 800000);
assert.equal(d.diff.INCOME, 1200500 - 800000);
assert.equal(d.quarterly[0].EXPENSE, 300000 + 40000 + 110000 + 20000);
assert.equal(d.day.INCOME.total, 1000500);
assert.equal(d.day.INCOME.rateVsPrevDay, (1000500 - 200000) / 200000);
assert.equal(d.day.EXPENSE.rateVsPrevDay, null);           // 비용은 전일 비용과 비교(없음)

// 월별
const m = R.computeMonthly(txs, cats, 2025, 'EXPENSE');
assert.equal(m.rows.find(r => r.category === '상품매입').months[2], 110000);
assert.equal(m.grandSum, 470000);

// 거래처별
const bp = R.computeByPartner(txs, '갑', '2025-01-01', '2025-12-31');
assert.equal(bp.periodSum.count, 2);
assert.equal(bp.cumulativeSum.INCOME, 1800000);

// 목록 필터
const f = R.filterTransactions(txs, { from: '2025-01-01', to: '2025-12-31', q: '매', qField: 'category', exact: false, pageSize: 2 });
assert.equal(f.pagination.totalItems, 4);            // 매출 2 + 상품매입 + 재료매입
assert.equal(f.data[0].id, 'A6A');                           // 최신순(03-04)
assert.equal(f.sums.byKind.EXPENSE.total, 130000);
assert.equal(R.filterTransactions(txs, { q: '매', qField: 'category', exact: true }).pagination.totalItems, 0);

// 부가세
assert.equal(R.computeVat(44546, 'SEPARATE'), 4454);        // 원 미만 절사
assert.equal(R.computeVat(44546, 'NONE'), 0);
assert.equal(R.computeVat(44546, 'SEPARATE', 4455), 4455);

// 자체 항목(OWN): (39) 기타에 합산 + 이름별 내역, 경고 없음
const cats2 = cats.map(c => c.name === '교재비' ? { ...c, formLine: 'OWN' } : c);
const es2 = R.computeExpenseStatement(txs, cats2, adj, 2025);
assert.equal(es2.lines.L39, 40000);
assert.equal(es2.lines.L41, es.lines.L41 + 40000);
assert.deepEqual(es2.ownItems, [{ category: '교재비', amount: 40000 }]);
assert.equal(es2.warnings.length, 0);

console.log('reports.test.js: 모든 검사 통과');
