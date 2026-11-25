# minutes.json スキーマ
```json
{
  "basic": {"date":"要確認","title":"要確認","format":"要確認","attendees":"…","absent":"なし/要確認"},
  "overview": ["1文目","2文目"],
  "prev_tasks": null,
  "agenda": [{"title":"議題名（約10分）","items":["内容1","内容2（発言から推定）"]}],
  "decisions": ["決定事項1"],
  "tasks": [{"no":"01","owner":"要確認","task":"対応事項","due":"未定"}],
  "next_meeting": "未定",
  "note": "（省略可）"
}
```
- `prev_tasks`: 前回議事録なしは null（「前回宿題無し」と出力）。ありは `[{"no","owner","task","due","progress"}]`
