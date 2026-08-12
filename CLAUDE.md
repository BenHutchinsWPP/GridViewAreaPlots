# Agent Notes

- Read `README.md` first.
- Real study exports and real grouping rollups are confidential. Do not commit
  CSVs or paste raw rows.
- Keep commit messages free of trailers such as `Co-Authored-By`,
  `Generated with`, or `Claude-Session`.
- Use `npm test` and `npm run build` before handing off code changes.
- `parser/block.wasm` is committed; rebuild it only when `parser/block.c`
  changes.
- Ingest must accept variable area counts, variable metric counts, and changing
  file area order. The WASM parser reads all of that at runtime; there is no
  second parse path and no JS fallback.
- Row order carries no meaning. The parser emits a row list and `blitBlock`
  scatters it; do not reintroduce an assumption that a block is a contiguous
  run of hours. The one refusal left is a duplicated `(area, hour)`.
- The area axis is read from the Name column of every row by `scan_axis`, never
  sampled from the first rows.
- Bump `ABI_VERSION` in `parser/block.c` and `PARSER_ABI` in
  `src/ingest/block.ts` together whenever the module's exports or arena layout
  change.
- Branch on `data/aggregation-rules.json`; do not re-derive sum vs weighted
  mean behavior in app code.
