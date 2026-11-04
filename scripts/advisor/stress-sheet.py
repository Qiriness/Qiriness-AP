"""The launch stress-test workbook (Qiriness_Chatbot_Launch_Stress_Tests_200.xlsx), read and written.

    python stress-sheet.py read  <workbook>                      -> JSON on stdout: { tests, smoke }
    python stress-sheet.py write <workbook> <out> <results.json> -> a COPY with the results filled in

Columns are found by their header text, not their letter, so a column the QA team inserts does
not shift what is read or written. The original workbook is never modified: the formulas on
« Pilotage » and « Smoke 25 » recalculate from the copy when it is opened.
"""
import json
import sys

import openpyxl

TESTS = "Tests (200)"
SMOKE = "Smoke 25"

READ = {
    "id": "ID", "priority": "Priorité", "category": "Catégorie", "objective": "Objectif", "mode": "Mode",
    "scenario": "Scénario", "turn": "Tour", "message": "Message client à envoyer", "criterion": "Critère de réussite",
    "setup": "État initial / données test", "truth": "Vérité à contrôler", "source": "Source / référence",
}
WRITE = {
    "reply": "Réponse du bot (à remplir)", "result": "Résultat", "failure_type": "Type d’échec",
    "ttft": "TTFT (s)", "total": "Temps total (s)", "notes": "Notes QA", "date": "Date test",
}


def columns(sheet):
    return {str(c.value).strip(): c.column for c in sheet[1] if c.value is not None}


def need(cols, header):
    if header not in cols:
        raise SystemExit(f"column « {header} » not found on « {TESTS} »")
    return cols[header]


def read(path):
    book = openpyxl.load_workbook(path, data_only=False)
    sheet = book[TESTS]
    cols = columns(sheet)
    at = {key: need(cols, header) for key, header in READ.items()}
    tests = []
    for row in range(2, sheet.max_row + 1):
        if sheet.cell(row, at["id"]).value is None:
            continue
        test = {"row": row}
        for key, col in at.items():
            value = sheet.cell(row, col).value
            test[key] = "" if value is None else (value if isinstance(value, (int, float)) else str(value).strip())
        tests.append(test)
    smoke = []
    if SMOKE in book.sheetnames:
        s = book[SMOKE]
        id_col = columns(s).get("Test ID")
        if id_col:
            smoke = [s.cell(r, id_col).value for r in range(2, s.max_row + 1) if s.cell(r, id_col).value is not None]
    json.dump({"tests": tests, "smoke": smoke}, sys.stdout, ensure_ascii=False)


def write(path, out, results_path):
    with open(results_path, encoding="utf-8") as f:
        results = json.load(f)
    book = openpyxl.load_workbook(path)
    sheet = book[TESTS]
    cols = columns(sheet)
    at = {key: need(cols, header) for key, header in WRITE.items()}
    for result in results:
        row = int(result["row"])
        for key, col in at.items():
            if key in result and result[key] is not None:
                value = result[key]
                # A cell holds at most 32,767 characters.
                sheet.cell(row, col).value = value[:32000] if isinstance(value, str) else value
    book.save(out)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    if len(sys.argv) >= 3 and sys.argv[1] == "read":
        read(sys.argv[2])
    elif len(sys.argv) >= 5 and sys.argv[1] == "write":
        write(sys.argv[2], sys.argv[3], sys.argv[4])
    else:
        raise SystemExit(__doc__)
