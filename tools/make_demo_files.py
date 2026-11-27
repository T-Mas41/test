"""動作確認用の架空データ(売上・受領・販売台帳・BMS形式CSV)を作成する。

使い方: python tools/make_demo_files.py [出力フォルダ]
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tests import dummy_data as dd  # noqa: E402


def main(out: Path) -> None:
    out.mkdir(parents=True, exist_ok=True)
    (out / "デモ_売上データ.xlsx").write_bytes(dd.sales_xlsx(dd.SALES))
    (out / "デモ_受領データ_標準.xlsx").write_bytes(dd.receipt_xlsx(dd.RECEIPT))
    (out / "デモ_受領データ_BMS.csv").write_bytes(dd.receipt_bms_csv(dd.RECEIPT))
    (out / "デモ_販売台帳.xlsx").write_bytes(dd.ledger_xlsx(dd.LEDGER))
    (out / "デモ_売上データ_複数販売先.xlsx").write_bytes(dd.sales_xlsx(dd.SALES_MULTI))
    print(f"作成しました: {out}(期間 2026/11/01〜2026/11/10 で照合できます。販売先は売上データから自動で判定されます)")


if __name__ == "__main__":
    main(Path(sys.argv[1]) if len(sys.argv) > 1 else Path("demo_files"))
