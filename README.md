# GridView Area Plots

Live: [GridViewAreaPlots](https://benhutchinswpp.github.io/GridViewAreaPlots)

Browser-only plots for GridView area CSV exports. Drop case CSVs and an optional
`Groupings.csv` onto the page, keep the metrics you need, and compare time
series, duration curves, box plots, and summary statistics.

Data stays local. The app is static: no server, no upload.

## Input

Expected case CSV shape:

- Columns: `Date`, `Hour`, `TOU`, `Name`, then GridView metrics. Those four key
  columns are the only fixed part of the layout.
- One row per area per hour. Area count, metric count and area order are read
  from the file; none of them is assumed. The area axis comes from the Name
  column of every row, not from a sample of the first few.
- One file is one case. Feb 29 is dropped so every case uses 8,760 hours.
- Areas are matched by trimmed `Name`; metrics are matched by trimmed header
  name, not by column position.
- Row order does not matter. Every row carries its own placement, so a
  value-sorted export loads identically to a date-ordered one. The only thing
  refused is the same area-hour appearing twice, which is what two exports
  concatenated into one file look like.

`Groupings.csv` maps `Name` to `Grouping`. Grouping series are built before
filters. Sum extensive metrics; use the weights in
`data/aggregation-rules.json` for price/intensive metrics.

## Run

```bash
npm install
npm run dev
```

Build and test:

```bash
npm test
npm run build
```

`parser/block.wasm` is committed. A normal build needs no wasm toolchain.
Rebuild it only when `parser/block.c` changes.

## Files

- `src/` - app code.
- `parser/` - SIMD WASM CSV parser.
- `data/aggregation-rules.json` - runtime aggregation rules.
- `test_*.mjs` - assert-based checks using synthetic data.

## Save And Load

Save writes a `.gvap` bundle containing processed cubes, not raw CSVs, and also
stores the same data in OPFS for fast reloads. Load restores a `.gvap` bundle.

## Privacy

This repo has a public remote and is deployed publicly. Do not commit real
study exports, real grouping rollups, or raw rows in docs, commits, issues, or
PRs. Aggregate statistics and timings are fine.
