// 실행: node tests/api.test.js — Google Sheets를 메모리로 흉내 내서 Code.gs의 api()를 그대로 호출한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function makeSheet(name, rows) {
  const data = rows.map(r => r.slice());
  const range = (r, c, nr, nc) => ({
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => (data[r - 1 + i] || [])[c - 1 + j] ?? '')),
    setValues: v => v.forEach((row, i) => { data[r - 1 + i] = data[r - 1 + i] || []; row.forEach((x, j) => { data[r - 1 + i][c - 1 + j] = typeof x === 'string' && x.startsWith("'") ? x.slice(1) : x; }); }),
    setNumberFormat: () => {},
  });
  return {
    data, getRange: range, getLastRow: () => data.length, getLastColumn: () => Math.max(...data.map(r => r.length)),
    getMaxRows: () => data.length + 100, deleteRow: r => data.splice(r - 1, 1), setFrozenRows: () => {},
  };
}

function load(seed) {
  const sheets = {};
  const ss = {
    getSheetByName: n => sheets[n] || null,
    insertSheet: n => (sheets[n] = makeSheet(n, [])),
  };
  const ctx = {
    console, Math, Date, JSON, Number, String, Object, Array, isFinite,
    SpreadsheetApp: { getActive: () => ss, flush: () => {} },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    Session: { getScriptTimeZone: () => 'Asia/Seoul' },
    Utilities: { formatDate: d => d.toISOString().slice(0, 10) },
  };
  vm.createContext(ctx);
  for (const f of ['Reports.gs', 'Code.gs']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script', f), 'utf8'), ctx);
  for (const [name, rows] of Object.entries(seed)) sheets[name] = makeSheet(name, [ctx.HEADERS[name], ...rows]);
  return { api: (a, p) => ctx.api(a, p), sheets };
}

const { api, sheets } = load({
  categories: [['INCOME', '매출', 'L11', 1, true], ['EXPENSE', '임차료', 'L27', 1, true], ['EXPENSE', '교재비', '', 2, true],
               ['ASSET', '가전제품', '', 1, true]],
  settings: [['vatDefault.INCOME', 'NONE'], ['vatDefault.EXPENSE', 'SEPARATE'], ['vatDefault.ASSET', 'NONE'], ['nextSeq', 1375], ['ownerName', '홍길동']],
  partners: [], adjustments: [], transactions: [],
});
const ok = r => { assert.equal(r.ok, true, JSON.stringify(r.error)); return r.data; };
const err = (r, code) => { assert.equal(r.ok, false); assert.equal(r.error.code, code); return r.error; };

// 입력 검증 — 원본 메시지 그대로
let e = err(api('transactions.create', { requestId: 'r0', kind: 'INCOME', date: '2025-02-30', category: '매출', supplyAmount: '1,000' }), 'VALIDATION_ERROR');
assert.match(e.message, /일자를 날짜형식/);
e = err(api('transactions.create', { requestId: 'r0', kind: 'INCOME', date: '2025-01-05', category: '없는구분', supplyAmount: 'abc' }), 'VALIDATION_ERROR');
assert.deepEqual(Object.keys(e.details.fields).sort(), ['category', 'supplyAmount']);

// 저장 + 부가세 자동 계산(비용 기본 = 별도) + 합계는 서버 계산
const t1 = ok(api('transactions.create', { requestId: 'r1', kind: 'EXPENSE', date: '2025-03-31', category: '임차료', supplyAmount: '450,000', totalAmount: 1 }));
assert.equal(t1.id, 'A1375A');
assert.equal(t1.vatAmount, 45000);
assert.equal(t1.totalAmount, 495000);

// 같은 requestId 재시도 → 새로 만들지 않음
const again = ok(api('transactions.create', { requestId: 'r1', kind: 'EXPENSE', date: '2025-03-31', category: '임차료', supplyAmount: 450000 }));
assert.equal(again.id, 'A1375A');
assert.equal(sheets.transactions.data.length, 2);
err(api('transactions.create', { requestId: 'r1', kind: 'EXPENSE', date: '2025-04-01', category: '임차료', supplyAmount: 450000 }), 'CONFLICT');

// 수식 주입 방지: 시트에는 글자로 저장
const t2 = ok(api('transactions.create', { requestId: 'r2', kind: 'INCOME', date: '2025-03-31', category: '매출', supplyAmount: 1000000, description: '=HYPERLINK("x")' }));
assert.equal(t2.vatAmount, 0);

// 수정: 낙관적 잠금
err(api('transactions.update', { id: t1.id, expectedUpdatedAt: 'old', supplyAmount: 1 }), 'CONFLICT');
const u = ok(api('transactions.update', { id: t1.id, expectedUpdatedAt: t1.updatedAt, supplyAmount: 400000 }));
assert.equal(u.vatAmount, 40000);                               // 금액을 바꾸면 부가세 다시 계산
assert.equal(u.createdAt, t1.createdAt);

// 목록 + 합계 (내부 _row는 밖으로 나가지 않음)
const list = ok(api('transactions.list', { from: '2025-01-01', to: '2025-12-31' }));
assert.equal(list.pagination.totalItems, 2);
assert.equal(list.sums.total, 1440000);
assert.equal('_row' in list.data[0], false);
err(api('transactions.list', { from: '2025-01-01' }), 'VALIDATION_ERROR');

// 미매핑 경고 → 매핑 지정 후 사라짐
ok(api('transactions.create', { requestId: 'r3', kind: 'EXPENSE', date: '2025-05-01', category: '교재비', supplyAmount: 100, vatMode: 'NONE' }));
let es = ok(api('reports.expenseStatement', { year: 2025 }));
assert.equal(es.warnings[0].category, '교재비');
assert.equal(es.lines.L41, 400000);
err(api('categories.update', { kind: 'EXPENSE', name: '교재비', formLine: 'L11' }), 'VALIDATION_ERROR'); // 수입 항목은 비용에 못 씀
err(api('categories.update', { kind: 'INCOME', name: '매출', formLine: 'OWN' }), 'VALIDATION_ERROR'); // 자체 항목은 비용만
ok(api('categories.update', { kind: 'EXPENSE', name: '교재비', formLine: 'OWN' }));
es = ok(api('reports.expenseStatement', { year: 2025 }));
assert.equal(es.warnings.length, 0);
assert.equal(es.lines.L41, 400100);
assert.equal(JSON.stringify(es.ownItems), JSON.stringify([{ category: '교재비', amount: 100 }]));
assert.equal(es.header.ownerName, '홍길동');

// 거래구분 이름 변경 → 과거 거래도 함께 변경
ok(api('categories.update', { kind: 'EXPENSE', name: '교재비', newName: '도서교재비' }));
assert.equal(ok(api('transactions.list', { q: '도서교재비', qField: 'category', exact: true })).pagination.totalItems, 1);
err(api('categories.create', { kind: 'EXPENSE', name: '새항목' }), 'VALIDATION_ERROR');   // 매핑 없이 추가 불가

// 세무조정 → 계산서 반영
ok(api('adjustments.put', { year: 2025, adjExpensePlus: '1,000' }));
assert.equal(ok(api('reports.incomeStatement', { year: 2025 })).lines.L18, 401100);
err(api('adjustments.put', { year: 2025, L14: 'abc' }), 'VALIDATION_ERROR');

// 거래처
const p = ok(api('partners.create', { name: '왜관문구', bizNo: '5042462839' }));
assert.equal(p.bizNo, '504-24-62839');
err(api('partners.create', { name: '왜관문구' }), 'CONFLICT');
err(api('partners.create', { name: 'x', bizNo: '123' }), 'VALIDATION_ERROR');

// 설정: 허용 키만
err(api('settings.update', { nextSeq: 1 }), 'VALIDATION_ERROR');
assert.equal(ok(api('settings.update', { bizName: '테스트교습소' })).bizName, '테스트교습소');

// 삭제(멱등) + CSV
assert.equal(ok(api('transactions.delete', { id: t2.id })).deleted, true);
assert.equal(ok(api('transactions.delete', { id: t2.id })).deleted, false);
const csv = ok(api('export.csv', { from: '2025-01-01', to: '2025-12-31' }));
assert.ok(csv.csv.startsWith('\uFEFF등록코드'));
assert.equal(ok(api('transactions.bulkDelete', { ids: ['A1375A', 'A1377A'] })).deletedCount, 2);

// 알 수 없는 요청
err(api('nope', {}), 'NOT_FOUND');
console.log('api.test.js: 모든 검사 통과');
