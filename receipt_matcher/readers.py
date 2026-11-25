"""Excel / CSV の読込。列は位置(1始まり)で扱う。"""
import csv
import io
import zipfile

import openpyxl

try:  # 高速なExcel読込(Rust製)。無い環境では openpyxl を使う
    from python_calamine import CalamineWorkbook
except ImportError:  # pragma: no cover
    CalamineWorkbook = None

ENCODINGS = {"cp932": "Shift_JIS(CP932)", "utf-8": "UTF-8", "utf-8-sig": "UTF-8(BOM付)"}
DELIMITERS = {",": "カンマ", "\t": "タブ"}


class ReadError(Exception):
    pass


def is_xlsx(data: bytes) -> bool:
    return zipfile.is_zipfile(io.BytesIO(data))


def read_rows(data: bytes, file_type: str, *, encoding: str = "cp932", delimiter: str = ",",
              sheet_name: str = "") -> list[list]:
    """全行を読み込む(行番号は index+1)。"""
    if file_type == "excel":
        if not is_xlsx(data):
            raise ReadError("Excel(.xlsx)ファイルではありません。古い形式(.xls)の場合は .xlsx で保存し直してください。")
        if CalamineWorkbook is not None:
            try:
                return _read_calamine(data, sheet_name)
            except ReadError:
                raise
            except Exception:  # noqa: BLE001  高速読込で読めない場合は openpyxl で読み直す
                pass
        return _read_openpyxl(data, sheet_name)
    if is_xlsx(data):
        raise ReadError("CSVを指定していますが、Excelファイルが選択されています。")
    try:
        txt = data.decode(encoding)
    except (UnicodeDecodeError, LookupError):
        raise ReadError(f"文字コード {ENCODINGS.get(encoding, encoding)} として読めません。レイアウトの文字コード設定を確認してください。")
    return [row for row in csv.reader(io.StringIO(txt, newline=""), delimiter=delimiter)]


def _sheet_error(name, names):
    return ReadError(f"シート「{name}」がありません(シート: {'、'.join(names)})")


def _read_calamine(data: bytes, sheet_name: str) -> list[list]:
    wb = CalamineWorkbook.from_filelike(io.BytesIO(data))
    if sheet_name:
        if sheet_name not in wb.sheet_names:
            raise _sheet_error(sheet_name, wb.sheet_names)
        sh = wb.get_sheet_by_name(sheet_name)
    else:
        sh = wb.get_sheet_by_index(0)
    return [list(r) for r in sh.to_python(skip_empty_area=False)]


def _read_openpyxl(data: bytes, sheet_name: str) -> list[list]:
    try:
        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as e:  # noqa: BLE001
        raise ReadError(f"Excelファイルを開けません({type(e).__name__})")
    try:
        if sheet_name:
            if sheet_name not in wb.sheetnames:
                raise _sheet_error(sheet_name, wb.sheetnames)
            ws = wb[sheet_name]
        else:
            ws = wb.worksheets[0]
        return [list(r) for r in ws.iter_rows(values_only=True)]
    finally:
        wb.close()


def cell(row: list, col: int):
    """1始まりの列番号で値を取り出す(列が足りなければ None)。"""
    i = col - 1
    return row[i] if 0 <= i < len(row) else None
