"""원본 간편장부(.xlsm) → 구글 시트 가져오기용 .xlsx 변환.

사용법:  python3 tools/migrate.py 원본.xlsm 장부데이터.xlsx
필요:    pip install openpyxl

만들어지는 시트: transactions, categories, partners, settings, adjustments
합계(금액+부가세)가 원본과 다른 행은 원본 합계를 유지하고 부가세를 (합계-금액)으로 고친 뒤 목록으로 보고한다.
"""
import sys
import datetime as dt
import warnings

import openpyxl

warnings.filterwarnings("ignore")

KIND = {"수입": "INCOME", "비용": "EXPENSE", "고정자산매입": "ASSET"}
AMOUNT_COLS = {"INCOME": (6, 7, 8), "EXPENSE": (9, 10, 11), "ASSET": (12, 13, 14)}  # 0-based G/H/I, J/K/L, M/N/O

# 원본 표준 항목 → 부표 항목. 여기 없는 사용자 추가 항목은 비워 두고 앱 설정 화면에서 고른다.
FORM_LINE = {
    "매출": "L11", "수강료": "L11", "기타(수입)": "L12",
    "상품매입": "L15_GOODS", "재료매입": "L19", "제조노무비": "L22", "제조경비": "L23",
    "급료": "L25", "월급여": "L25", "제세공과금": "L26", "임차료": "L27", "지급이자": "L28",
    "접대비": "L29", "기부금": "L30", "감가상각비": "L31", "차량유지비": "L32",
    "지급수수료": "L33", "소모품비": "L34", "복리후생비": "L35", "운반비": "L36",
    "광고선전비": "L37", "여비교통비": "L38", "기타(비용)": "L39",
}

HEADERS = {
    "transactions": ["id", "date", "kind", "category", "description", "partner", "supplyAmount",
                     "vatAmount", "totalAmount", "evidence", "memo", "vatMode", "createdAt",
                     "updatedAt", "requestId"],
    "categories": ["kind", "name", "formLine", "sortOrder", "isActive"],
    "partners": ["id", "name", "owner", "bizNo", "contact", "phone", "memo"],
    "settings": ["key", "value"],
    "adjustments": ["year", "L14", "L16", "L18", "L20", "adjIncomeMinus", "adjIncomePlus",
                    "adjExpenseMinus", "adjExpensePlus", "donationExcess", "donationCarryover"],
}
EVIDENCE = ["세금계산서", "계산서", "신용카드", "현금영수증", "간이영수증", "계좌이체", "현금"]


def s(v):
    return "" if v is None else str(v).strip()


def ymd(v):
    if isinstance(v, (dt.datetime, dt.date)):
        return v.strftime("%Y-%m-%d")
    return s(v)[:10]


def won(v):
    return int(round(float(v))) if v not in (None, "") else 0


def main(src, dst):
    wb = openpyxl.load_workbook(src, data_only=True)
    now = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    out = {k: [] for k in HEADERS}
    mismatches = []

    # 거래
    data = wb["DATA"]
    max_seq = 0
    for r in data.iter_rows(min_row=2, max_col=18, values_only=True):
        if not r[0]:
            continue
        kind = KIND[r[2]]
        a, v, t = (r[i] for i in AMOUNT_COLS[kind])
        supply, vat = won(a), won(v)
        if supply + vat != won(t) and won(t) >= supply:
            mismatches.append((r[0], ymd(r[1]), r[3], supply, vat, won(t)))
            vat = won(t) - supply  # 원본 합계(실제 지급액)를 믿고 부가세를 맞춘다 → 원본 보고서 숫자 유지
        out["transactions"].append([
            r[0], ymd(r[1]), kind, s(r[3]), s(r[4]), s(r[5]), supply, vat, supply + vat,
            s(r[15]), s(r[16]), "SEPARATE" if r[17] == 0 else "NONE", now, now, "",
        ])
        max_seq = max(max_seq, int("".join(c for c in r[0] if c.isdigit()) or 0))
    next_seq = max(int(data["U2"].value or 0), max_seq + 1)

    # 거래구분: 코드표(Option D/E/F) 순서 + 원장에만 있는 항목
    opt = wb["Option"]
    seen = []  # 순서 유지: 코드표 순서 → 원장에만 있는 항목
    for col, kind in ((4, "INCOME"), (5, "EXPENSE"), (6, "ASSET")):
        for row in range(2, opt.max_row + 1):
            name = s(opt.cell(row, col).value)
            if name and (kind, name) not in seen:
                seen.append((kind, name))
    for t in out["transactions"]:
        if (t[2], t[3]) not in seen:
            seen.append((t[2], t[3]))
    order = {"INCOME": 0, "EXPENSE": 0, "ASSET": 0}
    for kind, name in sorted(seen, key=lambda x: ["INCOME", "EXPENSE", "ASSET"].index(x[0])):
        order[kind] += 1
        line = FORM_LINE.get(name, "") if kind != "ASSET" else ""
        out["categories"].append([kind, name, line, order[kind], True])

    # 거래처
    ws = wb["거래처정보"]
    for i, r in enumerate(ws.iter_rows(min_row=7, min_col=2, max_col=7, values_only=True), 1):
        if s(r[0]):
            out["partners"].append([f"P{i:04d}", s(r[0]), s(r[1]), s(r[2]), s(r[3]), s(r[4]), s(r[5])])

    # 기본정보 (MAIN R/S열). 주민등록번호는 옮기지 않는다.
    main_ws = wb["MAIN"]
    info = {s(main_ws.cell(r, 18).value): main_ws.cell(r, 19).value for r in range(3, 18)}
    pick = {"ownerName": "성명", "birthDate": "생년월일", "address": "주소", "phone": "전화번호",
            "bizName": "상호", "bizNo": "사업자등록번호", "bizAddress": "사업장 소재지", "industry": "업종"}
    for key, label in pick.items():
        out["settings"].append([key, s(info.get(label))])
    code = next((v for k, v in info.items() if k.startswith("주업종코드")), "")
    out["settings"].append(["industryCode", s(code)])
    vat_cells = [opt["J15"].value, opt["J16"].value, opt["J17"].value]
    for kind, v in zip(("INCOME", "EXPENSE", "ASSET"), vat_cells):
        out["settings"].append([f"vatDefault.{kind}", "SEPARATE" if v == 0 else "NONE"])
    out["settings"].append(["evidenceOptions", ",".join(EVIDENCE)])
    out["settings"].append(["nextSeq", next_seq])
    out["settings"].append(["schemaVersion", 1])

    # 세무조정·재고: 원본 서식 시트에 남아 있는 입력값(대부분 비어 있음)
    s9, s10 = wb["총수입금액및필요경비명세서"], wb["간편장부소득금액계산서"]
    year = s9["G11"].value.year if isinstance(s9["G11"].value, dt.datetime) else None
    vals = [s9["G17"].value, s9["G20"].value, s9["G22"].value, s9["G24"].value,
            s10["F15"].value, s10["F16"].value, s10["F19"].value, s10["F20"].value,
            s10["F23"].value, s10["F24"].value]
    if year and any(v not in (None, "") for v in vals):
        out["adjustments"].append([year] + [won(v) for v in vals])

    # 쓰기 — 날짜·코드·전화번호는 텍스트로 고정해 구글 시트가 숫자/날짜로 바꾸지 않게 한다.
    wbo = openpyxl.Workbook()
    wbo.remove(wbo.active)
    text_cols = {"transactions": {0, 1, 12, 13}, "partners": {3, 5}, "settings": {1}}
    for name, header in HEADERS.items():
        ws = wbo.create_sheet(name)
        ws.append(header)
        for row in out[name]:
            ws.append(row)
        for ci in text_cols.get(name, ()):
            for cell in ws.iter_cols(min_col=ci + 1, max_col=ci + 1, min_row=2).__next__():
                cell.value = s(cell.value)
                cell.number_format = "@"
        ws.freeze_panes = "A2"
    wbo.save(dst)

    unmapped = [c[1] for c in out["categories"] if c[0] != "ASSET" and not c[2]]
    print(f"거래 {len(out['transactions'])}건, 거래구분 {len(out['categories'])}개, "
          f"거래처 {len(out['partners'])}곳, 다음 일련번호 {next_seq}")
    print("부표 항목 미지정 거래구분(앱 설정에서 지정 필요):", ", ".join(unmapped) or "없음")
    if mismatches:
        print(f"원본 합계가 금액+부가세와 다른 행 {len(mismatches)}건 (부가세를 합계-금액으로 교정):")
        for m in mismatches:
            print("  ", m[0], m[1], m[2], f"금액 {m[3]:,} + 부가세 {m[4]:,} ≠ 원본합계 {m[5]:,}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
