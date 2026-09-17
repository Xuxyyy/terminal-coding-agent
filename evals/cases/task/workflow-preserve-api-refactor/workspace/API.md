# Record report API

The package exports exactly three named functions from `src/index.js`:

- `formatRecord(record, options?)` returns one display line. Names and tag text
  are trimmed, blank tags are removed, numeric strings are converted to
  numbers, and invalid or missing scores become `0`. A record is active unless
  `active` is exactly `false`. Empty names display as `(unnamed)`. Pass
  `{includeTags: false}` to omit tags from the line.
- `buildReport(records)` returns `{count, activeCount, scoreTotal, records}`.
  Its `records` field contains normalized copies; callers' records are never
  mutated. A non-array argument throws `TypeError("records must be an array")`.
- `renderReport(records)` returns a summary header followed by one formatted
  line per record.

The refactor may change internal modules, but these exports, return shapes,
formatting rules, errors, and input immutability are public behavior.
