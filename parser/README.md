# CSV Parser

`block.c` / `block.wasm` is the only CSV parse path. It reads the export's
shape at runtime — area count, source metric count, which source columns are
retained, and how many rows a block holds all arrive from JS through
`configure()`. Nothing about a particular export is compiled in.

An earlier version fixed the shape at 43 areas × 50 metrics and sent every
other export to a JS fallback. That fallback measured 51 MiB/s against the
module's 241 MiB/s on the same data, and it is gone.

Rows are routed by trimmed `Name` and metrics by trimmed header name. File
area order is not trusted.

## Build

```bash
sudo apt-get install -y lld-18     # supplies wasm-ld
./build.sh
```

The output is `parser/block.wasm`. Commit it with any `block.c` change, and
bump `ABI_VERSION` whenever the exported surface or the arena layout changes —
`instantiateParser` refuses a mismatch, which is what stops a stale committed
binary from becoming a wrong number.

## Rules

- Derive hour and area from each row's own `Date`, `Hour`, and `Name` fields.
- Read `TOU` from the file; do not derive it.
- Count Feb 29 separately; dropping it is expected.
- Preserve exponent notation support such as `7E-05`.
- Size buffers to a BLOCK, never to a whole case. Each Worker holds its own
  instance, so anything sized to a case is multiplied by the pool.
- Hour arithmetic lives here and only here. A row's `(area, hour)` is computed
  in `parse_block` and travels with the row; no JS-side code re-derives it, so
  there is nothing to drift. `dayOfYear` in `header.ts` mirrors `date_to_day`
  for the T4 reference parser alone — keep it a field-for-field mirror, and note
  that a drift surfaces as a T4 cube mismatch rather than as a wrong load.

## The axis scan

`scan_axis` reads every row's Name and nothing else, skipping each row's metric
fields whole rather than splitting them. Measured at **31 ms / 4.3 GiB/s** on
the 133 MB reference export against ~560 ms for the full parse — so the area
axis is read from the data for about 5% of ingest. That timing predates
dropping the Date/Hour parse from this pass, so it is now an upper bound.

It replaced a guess. The old rule read Name from the header probe until a name
repeated, which assumes an export's first hour lists every area exactly once.
On a shuffled export it returned 10 areas of 43 and said nothing; on any file
whose first hour is incomplete it silently drops areas. The axis is data, so
it is read from the data.

`discoverAreas` consumes two things from this pass: the distinct names, which
become the area axis, and the row count per block, which becomes the exact
`maxRows` bound for the parse pass over those same bytes.

That is all it reports, and the omission is the point. It used to also export
`axis_unordered`, `axis_min_hour` and `axis_max_hour` — an inversion count and
the block's hour range — which fed the old slab's ordering verdict and its
block-tiling check. The row list retired both, nothing read them for several
commits, and they were removed in ABI 5. Do not add them back: an inversion
count is not a defect once row order carries no meaning, and a live one invites
a refusal of files this parser reads correctly. The only thing still refused is
a duplicated `(area, hour)`, which `blitBlock` catches from the rows themselves.

## Row order does not matter

`parse_block` emits a ROW LIST — `values[row * planes + p]` with the row's own
`(area, hour)` — and the main thread scatters it into the cube. Nothing in the
pipeline assumes rows arrive in any particular order, inside a block or across
blocks. A value-sorted export produces a byte-identical cube to a date-ordered
one; `test_ingest.mjs` asserts exactly that, and also compares a shuffled
export cell-by-cell against the independent reference parser.

This replaced an hour-windowed slab, which needed a block to be a contiguous
run of hours and refused anything else. Measured on the 133 MB export,
single-threaded:

| | slab | row list |
|---|---|---|
| axis scan | 34 ms | 33 ms |
| parse | 518 ms | 541 ms |
| cube fill | 13 ms | 47 ms |
| **total** | **565 ms** | **621 ms** |

So order-independence costs about 10%. The cube fill is the part that grew: a
contiguous run is one `memcpy` per (plane, area), a row list is one write per
cell.

Two things make that 47 ms rather than 96 ms, and only one of them is the
obvious one:

- **Bucket rows by area before writing.** An area's planes are one contiguous
  ~1.7 MB region of the cube, so this keeps the writes inside it instead of
  walking the whole 72 MB. Worth 2.4x on its own.
- **Step the inner loop instead of indexing a table.** When the retained planes
  land on consecutive cube metrics, the per-plane offset is an arithmetic step.
  62 ms with the lookup, 41 ms with the step. This was the larger win by far
  and it is easy to lose in a refactor.

Measured and rejected: having the WORKER emit rows already area-bucketed, so
the main thread neither sorts nor reads out of order. It needs per-area row
counts from the scan, a bucket cursor per area in the parser, and those counts
plumbed through every layer — and it moved the cube fill by 2-5 ms. The
main-thread counting sort is O(rows) and cheap; the read pattern it spoils
turns out not to matter. Not worth the machinery.

Note the cube fill runs on the main thread while scan and parse are spread
across the worker pool, so it weighs more in wall-clock than the table
suggests.

### The one thing still refused

Two rows for the same `(area, hour)`. The scatter would keep whichever worker
finished last, silently, so `blitBlock` carries a one-bit-per-(area, hour)
coverage map — 47 KB for a 43-area case, because duplicates are per row, not
per cell — and refuses. Two exports of one year concatenated into a single file
is what produces this.

## Memory

Per instance: a 12 MiB input window plus a 20 MiB arena holding one block's
values, per-row `(area, hour)` pair, TOU and column plan. The values are
`maxRows × planes × 4 B` — proportional to the block, not to the case, and not
to the hour range the block happens to touch. A block of L bytes holds at most
`L / bytesPerRow` rows and a row carrying `metrics` fields is at least
`2 × (4 + metrics)` bytes, so with `planes ≤ metrics` the values stay under
`2 × L` whatever the shape. A shape that does not fit makes `configure()`
return 0 and JS raises an error rather than parsing into a stale layout.
