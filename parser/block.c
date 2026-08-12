// The WASM CSV parser.
//
// Nothing about the export's shape is compiled in. Area count, source metric
// count, which source columns are retained, and how many rows one block holds
// all arrive from JS through configure() and are laid out in an arena. An
// earlier version fixed them at 43 areas x 50 metrics and sent every other
// shape to a JS fallback that measured 4.7x slower on real data.
//
// Three properties this file exists to keep:
//
// 1. MEMORY IS A FUNCTION OF BLOCK SIZE, NEVER CASE SIZE. Every Worker needs
//    its own WASM instance (linear memory cannot be shared without
//    SharedArrayBuffer on GitHub Pages), so sizing to a case means
//    8 workers x 140 MiB and the memory budget fails before one case is
//    retained. A block's output is [rows x planes] floats plus one (area, hour)
//    pair per row -- proportional to the block, whatever the rows contain.
//
// 2. ROW ORDER DOES NOT MATTER. Every row carries its own placement, so the
//    output is a row list rather than an hour-windowed slab and the main
//    thread scatters it into the cube. An earlier version needed rows ordered
//    by (Date, Hour) so a block was a contiguous run of hours; a value-sorted
//    export was refused. Nothing here assumes an order now.
//
// 3. BLOCKS ARE INDEPENDENT. Area and hour come from each row's OWN fields
//    (Date / Hour / Name), never from a global row counter, so a worker needs
//    its bytes and not its position in the file.
//
// 4. SILENCE IS THE ENEMY. Every failure this module can see is counted and
//    reported to JS, which refuses the load. A plausible wrong number is worse
//    than an error.
//
// Build: parser/build.sh

#include <wasm_simd128.h>

// Bumped on any change to the exported surface or the slab layout. block.wasm
// is committed, so a stale binary against updated TypeScript has to be an
// error at instantiate rather than a wrong number at parse time.
#define ABI_VERSION 5u

#define INBUF_BYTES (12u * 1024u * 1024u)

// Values + row index + TOU + areaSeen + the column plan, for ONE block.
//
// A block's values are rows * planes * 4 B. A block of L bytes holds at most
// L / bytesPerRow rows, and a row carrying `metrics` fields is at least
// 2 * (4 + metrics) bytes, so with planes <= metrics the values stay under
// 2 * L whatever the shape. 20 MiB covers the 8 MiB blocks the pool cuts with
// margin; a shape that does not fit makes configure() fail, which JS turns
// into an error rather than a truncated parse.
#define ARENA_BYTES (20u * 1024u * 1024u)

// Open addressing, filled once at startup from the union area axis. Static and
// never resized: the pool tears down and rebuilds every worker when the axis
// changes, so a later configure() must not be able to move or re-mask this
// table underneath a half-filled state.
#define AREA_TABLE 4096u

#define INVALID 0xFFFFFFFFu
#define NO_AREA INVALID

static unsigned char inbuf[INBUF_BYTES];
static unsigned char arena[ARENA_BYTES] __attribute__((aligned(16)));

static unsigned areaHash[AREA_TABLE];
static unsigned areaIdx[AREA_TABLE];

#define HOURS_PER_YEAR 8760u

// Arena regions, re-pointed by configure().
static int*            planeOf;   // [sourceMetrics] source metric -> output plane, or -1
static float*          values;    // [maxRows * numPlanes], row-major
static unsigned short* rowArea;   // [maxRows] cube area index of each emitted row
static unsigned short* rowHour;   // [maxRows] hour-of-year of each emitted row
static unsigned char*  touOut;    // [8760], 0 = OffPeak, 1 = OnPeak, 0xFF = uncovered
static unsigned char*  areaSeen;  // [numAreas], 1 = at least one row in this block

static unsigned g_numAreas, g_numPlanes, g_maxRows, g_sourceMetrics;
static unsigned g_rows, g_emitted, g_unknownArea, g_droppedDate, g_overflow;

__attribute__((export_name("abi_version")))       unsigned       abi_version(void)       { return ABI_VERSION; }
__attribute__((export_name("inbuf_ptr")))         unsigned char* inbuf_ptr(void)         { return inbuf; }
__attribute__((export_name("inbuf_size")))        unsigned       inbuf_size(void)        { return INBUF_BYTES; }
__attribute__((export_name("arena_bytes")))       unsigned       arena_bytes(void)       { return ARENA_BYTES; }
__attribute__((export_name("plane_of_ptr")))      int*            plane_of_ptr(void)      { return planeOf; }
__attribute__((export_name("values_ptr")))        float*          values_ptr(void)        { return values; }
__attribute__((export_name("row_area_ptr")))      unsigned short* row_area_ptr(void)      { return rowArea; }
__attribute__((export_name("row_hour_ptr")))      unsigned short* row_hour_ptr(void)      { return rowHour; }
__attribute__((export_name("tou_ptr")))           unsigned char*  tou_ptr(void)           { return touOut; }
__attribute__((export_name("area_seen_ptr")))     unsigned char*  area_seen_ptr(void)     { return areaSeen; }
__attribute__((export_name("last_rows")))         unsigned        last_rows(void)         { return g_rows; }
__attribute__((export_name("last_emitted")))      unsigned        last_emitted(void)      { return g_emitted; }
__attribute__((export_name("last_unknown_area"))) unsigned        last_unknown_area(void) { return g_unknownArea; }
__attribute__((export_name("last_dropped_date"))) unsigned        last_dropped_date(void) { return g_droppedDate; }
__attribute__((export_name("last_overflow")))     unsigned        last_overflow(void)     { return g_overflow; }

/**
 * Lay the arena out for one block. `maxRows` comes from the axis scan, which
 * counted this exact byte range, so it is an exact bound rather than a guess.
 * Returns 0 if the layout does not fit, which the caller must treat as an
 * error -- parsing into a stale layout would write one block's floats at
 * another block's stride.
 */
__attribute__((export_name("configure")))
unsigned configure(unsigned numAreas, unsigned numPlanes, unsigned maxRows, unsigned sourceMetrics) {
  if (numAreas == 0u) return 0u;

  // 64-bit: rows * planes overflows 32 bits long before it overflows the
  // arena check that is supposed to catch it.
  unsigned long long cells = (unsigned long long)maxRows * numPlanes;
  unsigned long long need = (unsigned long long)sourceMetrics * 4ull + cells * 4ull +
                            (unsigned long long)maxRows * 4ull + HOURS_PER_YEAR +
                            (unsigned long long)numAreas;
  if (need > (unsigned long long)ARENA_BYTES) return 0u;

  // planeOf and values hold 4-byte types, rowArea/rowHour 2-byte. The arena is
  // 16-aligned and every region size above is a multiple of its own width, so
  // each region starts aligned.
  unsigned off = 0u;
  planeOf  = (int*)(arena + off);             off += sourceMetrics * 4u;
  values   = (float*)(arena + off);           off += (unsigned)cells * 4u;
  rowArea  = (unsigned short*)(arena + off);  off += maxRows * 2u;
  rowHour  = (unsigned short*)(arena + off);  off += maxRows * 2u;
  touOut   = arena + off;                     off += HOURS_PER_YEAR;
  areaSeen = arena + off;

  g_numAreas      = numAreas;
  g_numPlanes     = numPlanes;
  g_maxRows       = maxRows;
  g_sourceMetrics = sourceMetrics;
  return 1u;
}

__attribute__((export_name("area_table_reset")))
void area_table_reset(void) {
  for (unsigned i = 0; i < AREA_TABLE; i++) { areaHash[i] = 0; areaIdx[i] = NO_AREA; }
}

/** Returns 0 if the table is full, so JS can refuse rather than lose an area. */
__attribute__((export_name("area_table_put")))
unsigned area_table_put(unsigned hash, unsigned idx) {
  unsigned s = hash & (AREA_TABLE - 1u);
  for (unsigned p = 0; p < AREA_TABLE; p++) {
    unsigned k = (s + p) & (AREA_TABLE - 1u);
    if (areaIdx[k] == NO_AREA) { areaHash[k] = hash; areaIdx[k] = idx; return 1u; }
  }
  return 0u;
}

static inline unsigned area_lookup(unsigned hash) {
  unsigned s = hash & (AREA_TABLE - 1u);
  for (unsigned p = 0; p < AREA_TABLE; p++) {
    unsigned k = (s + p) & (AREA_TABLE - 1u);
    if (areaIdx[k] == NO_AREA) return NO_AREA;
    if (areaHash[k] == hash) return areaIdx[k];
  }
  return NO_AREA;
}

static inline unsigned fnv1a(const unsigned char* p, const unsigned char* e) {
  unsigned h = 0x811c9dc5u;
  for (; p < e; p++) { h ^= *p; h *= 0x01000193u; }
  return h;
}

// Cumulative days before each month, non-leap. Feb 29 is dropped at ingest
// (D4), so a leap year uses the same table and the Feb 29 rows are skipped.
static const unsigned short CUM[12] = {0,31,59,90,120,151,181,212,243,273,304,334};

// f64 digit accumulation -- measured FASTER than the Eisel-Lemire u64-mantissa
// approach on wasm32 in lever-1 (130.2 ms vs 157.0 ms). Do NOT "optimize" this
// into fast_float's algorithm; it loses here.
// Exponent notation IS present in real exports -- testcase.csv carries
// `7E-05` and `8E-05` for near-zero A.S. amounts, and the export writes
// tiny magnitudes that way rather than as long decimal strings. Returning
// NaN on them (as this did until T4 caught it cell-by-cell) is silent data
// loss: the cell simply reads as absent, which every kernel is designed to
// skip without complaint.
static inline float parse_float(const unsigned char* p, const unsigned char* e) {
  if (e <= p) return 0.0f / 0.0f;
  int neg = 0;
  if (*p == '-') { neg = 1; p++; }
  else if (*p == '+') { p++; }

  // Integer part, then `frac / scale`. This rounds twice where a correctly
  // rounded strtod rounds once, and on the two 8-digit money columns that
  // shows up as a 1-ulp float32 difference in 8 cells out of 18,834,000
  // (worst relative 9.79e-8, under one f32 ulp of 1.19e-7).
  //
  // MEASURED, do not "fix" this:
  //   * Folding both parts into one f64 mantissa with a single division
  //     costs 20% throughput (204 -> 160 MiB/s) and changes none of the 8
  //     cells -- those values carry 18 significant digits, so the mantissa
  //     is inexact either way.
  //   * Eisel-Lemire was slower on wasm32 in the parser measurements.
  // The residual is below f32 storage precision by construction, which is
  // the only reason it is acceptable. T4 gates it at <= 1 ulp, not at zero.
  double ip = 0.0;
  while (p < e) {
    unsigned d = (unsigned)(*p - '0');
    if (d > 9) break;
    ip = ip * 10.0 + (double)d;
    p++;
  }
  double v = ip;
  if (p < e && *p == '.') {
    p++;
    double f = 0.0, sc = 1.0;
    while (p < e) {
      unsigned d = (unsigned)(*p - '0');
      if (d > 9) break;
      f = f * 10.0 + (double)d;
      sc *= 10.0;
      p++;
    }
    v += f / sc;
  }
  if (p < e && (*p == 'e' || *p == 'E')) {
    p++;
    int eneg = 0;
    if (p < e && (*p == '-' || *p == '+')) { eneg = (*p == '-'); p++; }
    int ex = 0;
    while (p < e) {
      unsigned d = (unsigned)(*p - '0');
      if (d > 9) break;
      ex = ex * 10 + (int)d;
      if (ex > 400) ex = 400;   // past f32 range either way
      p++;
    }
    // Exponentiation by squaring: no libm in a freestanding module, and a
    // POW10 table would still need this path for the out-of-table cases.
    double scale = 1.0, base = 10.0;
    for (int k = ex; k; k >>= 1) { if (k & 1) scale *= base; base *= base; }
    v = eneg ? v / scale : v * scale;
  }

  // Anything left over is garbage, not a number. Kept strict: the old loop
  // bailed to NaN on the first non-digit, and a partial parse of a mangled
  // field would be a plausible-looking wrong number.
  if (p != e) return 0.0f / 0.0f;
  return (float)(neg ? -v : v);
}

static inline unsigned parse_uint(const unsigned char* p, const unsigned char* e) {
  unsigned v = 0;
  for (; p < e; p++) {
    unsigned d = (unsigned)(*p - '0');
    if (d > 9) break;
    v = v * 10u + d;
  }
  return v;
}

// M/D/YYYY -> day-of-year. Returns INVALID for Feb 29 (dropped, D4) or garbage.
static inline unsigned date_to_day(const unsigned char* p, const unsigned char* e) {
  unsigned month = 0, day = 0;
  while (p < e && *p != '/') { month = month * 10u + (unsigned)(*p - '0'); p++; }
  p++;
  while (p < e && *p != '/') { day = day * 10u + (unsigned)(*p - '0'); p++; }
  if (month < 1 || month > 12 || day < 1 || day > 31) return INVALID;
  if (month == 2 && day == 29) return INVALID;   // D4: Feb 29 dropped
  return CUM[month - 1] + day - 1;
}

// ---------------------------------------------------------------- axis scan
//
// The area axis used to be guessed from the first rows of the header probe:
// read Name until one repeats. That is wrong for any export whose first hour
// does not happen to list every area exactly once -- it returned 10 areas of
// 43 on a shuffled file and said nothing. The axis is data, so it is read from
// the data: one pass over every row's KEY columns, which is ~4x cheaper than a
// full parse because the metric fields are skipped whole rather than split.

#define NAME_TABLE 8192u   // power of two, open addressing
#define MAX_NAMES  4096u   // <= AREA_TABLE: an axis larger than this cannot be routed

static unsigned nameHash[NAME_TABLE];
static unsigned nameSlot[NAME_TABLE];
static unsigned nameOff[MAX_NAMES];
static unsigned nameLen[MAX_NAMES];
static unsigned g_names, g_scanRows, g_scanOverflow;

__attribute__((export_name("axis_names")))     unsigned  axis_names(void)     { return g_names; }
__attribute__((export_name("axis_off_ptr")))   unsigned* axis_off_ptr(void)   { return nameOff; }
__attribute__((export_name("axis_len_ptr")))   unsigned* axis_len_ptr(void)   { return nameLen; }
__attribute__((export_name("axis_rows")))      unsigned  axis_rows(void)      { return g_scanRows; }
__attribute__((export_name("axis_overflow")))  unsigned  axis_overflow(void)  { return g_scanOverflow; }

static inline unsigned find_byte(const unsigned char* b, unsigned i, unsigned end, unsigned char target) {
  const v128_t v = wasm_i8x16_splat((char)target);
  for (; i + 16u <= end; i += 16u) {
    unsigned mask = (unsigned)wasm_i8x16_bitmask(wasm_i8x16_eq(wasm_v128_load(b + i), v));
    if (mask) {
      unsigned at = i + (unsigned)__builtin_ctz(mask);
      return at < end ? at : end;
    }
  }
  for (; i < end; i++) if (b[i] == target) return i;
  return end;
}

/** Record a distinct name, storing where its first occurrence sits in inbuf so
 * JS can decode the few bytes rather than every row's Name field. */
static inline void name_insert(const unsigned char* b, unsigned s, unsigned e) {
  unsigned h = fnv1a(b + s, b + e);
  unsigned start = h & (NAME_TABLE - 1u);
  for (unsigned p = 0; p < NAME_TABLE; p++) {
    unsigned k = (start + p) & (NAME_TABLE - 1u);
    if (nameSlot[k] == INVALID) {
      if (g_names >= MAX_NAMES) { g_scanOverflow++; return; }
      nameHash[k] = h;
      nameSlot[k] = g_names;
      nameOff[g_names] = s;
      nameLen[g_names] = e - s;
      g_names++;
      return;
    }
    if (nameHash[k] == h) {
      // Same hash is not the same name. Confirming by bytes costs one compare
      // per distinct area and stops an FNV collision from dropping an area
      // silently -- a missing area is a missing series, with nothing thrown.
      unsigned idx = nameSlot[k];
      if (nameLen[idx] == e - s) {
        unsigned q = 0;
        while (q < nameLen[idx] && b[nameOff[idx] + q] == b[s + q]) q++;
        if (q == nameLen[idx]) return;
      }
      // Genuine collision: keep probing so both names get a slot.
    }
  }
  g_scanOverflow++;
}

/**
 * Read every row's Name and nothing else. Fills the distinct name table and
 * counts non-blank rows, which is the exact `maxRows` bound for a parse over
 * these same bytes.
 *
 * It does NOT look at Date or Hour. It used to, to count rows whose hour went
 * backwards and to report the hour range the block covered -- both of which
 * existed for the hour-windowed slab, which needed a block to be a contiguous
 * run of hours. The row list retired that, and an inversion count is not a
 * defect to report once row order carries no meaning. The one thing still
 * refused is a duplicated (area, hour), and blitBlock catches that from the
 * rows themselves.
 */
__attribute__((export_name("scan_axis")))
unsigned scan_axis(unsigned len) {
  const unsigned char* b = inbuf;
  g_names = 0; g_scanRows = 0; g_scanOverflow = 0;
  for (unsigned i = 0; i < NAME_TABLE; i++) nameSlot[i] = INVALID;

  unsigned i = 0;

  while (i < len) {
    unsigned rowEnd = find_byte(b, i, len, '\n');
    if (rowEnd == i) { i++; continue; }             // blank line, not a row
    g_scanRows++;

    // Date and Hour are not read, but the comma chain still has to walk past
    // them to reach Name at column 3.
    unsigned c0 = find_byte(b, i, rowEnd, ',');
    unsigned c1 = find_byte(b, c0 + 1u, rowEnd, ',');
    unsigned c2 = find_byte(b, c1 + 1u, rowEnd, ',');
    unsigned c3 = find_byte(b, c2 + 1u, rowEnd, ',');

    if (c2 < rowEnd) {
      unsigned s = c2 + 1u, e = c3;
      if (e > s && b[e - 1u] == '\r') e--;
      while (s < e && (b[s] == ' ' || b[s] == '\t')) s++;
      while (e > s && (b[e - 1u] == ' ' || b[e - 1u] == '\t')) e--;
      if (e > s) name_insert(b, s, e);
    }

    // Everything past Name is skipped WHOLE. That is the entire reason this
    // pass is cheap: find_byte already ran to the row terminator.
    i = rowEnd + 1u;
  }
  return g_scanRows;
}

/**
 * Parse a block of WHOLE rows: `len` bytes in inbuf, starting at a row boundary
 * and ending just after a '\n'.
 *
 * Output is a ROW LIST, not a slab: values[row * numPlanes + plane] with the
 * row's placement in rowArea[row] / rowHour[row]. Nothing here depends on the
 * order rows arrive in, so a value-sorted export parses exactly like a
 * date-ordered one.
 *
 * Column roles: Date, Hour, TOU, Name at 0-3, then source metric `col - 4`
 * routed through planeOf. Metrics are matched to cube columns BY TRIMMED HEADER
 * NAME on the JS side and arrive here already resolved -- never by position.
 */
__attribute__((export_name("parse_block")))
unsigned parse_block(unsigned len) {
  const unsigned char* b = inbuf;
  unsigned col = 0u, fs = 0u;
  unsigned rowDay = INVALID, rowHourOfDay = 0u, rowTou = 0xFFu;
  unsigned area = NO_AREA, slot = INVALID, rowBase = 0u;

  g_rows = 0u; g_emitted = 0u; g_unknownArea = 0u; g_droppedDate = 0u; g_overflow = 0u;

  // Every cell a row does not write must read as absent -- not as the previous
  // block's float, and not as zero. Done here rather than in a separate export
  // so no caller can skip it.
  {
    const v128_t nan4 = wasm_f32x4_splat(0.0f / 0.0f);
    unsigned n = g_maxRows * g_numPlanes;
    unsigned i = 0u;
    for (; i + 4u <= n; i += 4u) wasm_v128_store(values + i, nan4);
    for (; i < n; i++) values[i] = 0.0f / 0.0f;
  }
  for (unsigned k = 0; k < HOURS_PER_YEAR; k++) touOut[k] = 0xFFu;
  for (unsigned k = 0; k < g_numAreas; k++) areaSeen[k] = 0;

  #define FIELD(END)                                                            \
    {                                                                           \
      unsigned e = (END);                                                       \
      if (e > fs && b[e - 1] == '\r') e--;                                      \
      if (col == 0u) {                                                          \
        rowDay = date_to_day(b + fs, b + e);                                    \
      } else if (col == 1u) {                                                   \
        rowHourOfDay = parse_uint(b + fs, b + e);                               \
      } else if (col == 2u) {                                                   \
        /* "OnPeak" / "OffPeak" differ at byte 1: 'n' vs 'f'. */                \
        rowTou = (e > fs + 1u && b[fs + 1u] == 'n') ? 1u : 0u;                  \
      } else if (col == 3u) {                                                   \
        /* The axis is built from TRIMMED names, so the hash must see the       \
           trimmed bytes or a padded Name field becomes an unknown area and     \
           refuses a file that is merely spaced. */                             \
        unsigned s = fs, t = e;                                                 \
        while (s < t && (b[s] == ' ' || b[s] == '\t')) s++;                     \
        while (t > s && (b[t - 1] == ' ' || b[t - 1] == '\t')) t--;             \
        area = area_lookup(fnv1a(b + s, b + t));                                \
        if (area >= g_numAreas) { area = NO_AREA; g_unknownArea++; }            \
        unsigned h = (rowDay != INVALID && rowHourOfDay >= 1u &&                \
                      rowHourOfDay <= 24u) ? rowDay * 24u + (rowHourOfDay - 1u) \
                                           : INVALID;                           \
        slot = INVALID;                                                         \
        if (h == INVALID) g_droppedDate++;                                      \
        else if (area != NO_AREA) {                                             \
          areaSeen[area] = 1;                                                   \
          touOut[h] = (unsigned char)rowTou;                                    \
          if (g_emitted < g_maxRows) {                                          \
            slot = g_emitted++;                                                 \
            /* Hoisted: the metric branch below runs once per FIELD, and         \
               recomputing slot * numPlanes there is a multiply and a global     \
               load on every one of the file's ~19M value cells. */              \
            rowBase = slot * g_numPlanes;                                       \
            rowArea[slot] = (unsigned short)area;                               \
            rowHour[slot] = (unsigned short)h;                                  \
          } else g_overflow++;                                                  \
        }                                                                       \
      } else {                                                                  \
        unsigned m = col - 4u;                                                  \
        if (slot != INVALID && m < g_sourceMetrics) {                           \
          int pl = planeOf[m];                                                  \
          if (pl >= 0 && (unsigned)pl < g_numPlanes) {                          \
            values[rowBase + (unsigned)pl] = parse_float(b + fs, b + e);        \
          }                                                                     \
        }                                                                       \
      }                                                                         \
    }

  #define EMIT(AT)                                                              \
    {                                                                           \
      unsigned at = (AT);                                                       \
      unsigned start = fs;                                                      \
      FIELD(at)                                                                 \
      fs = at + 1u;                                                             \
      col++;                                                                    \
      if (b[at] == '\n') {                                                      \
        unsigned end = at;                                                      \
        if (end > start && b[end - 1] == '\r') end--;                           \
        /* A blank line is not a row. The reference parser T4 compares against  \
           skips them too, and the row counts have to agree. */                 \
        if (col > 1u || end > start) g_rows++;                                  \
        col = 0u; area = NO_AREA; slot = INVALID; rowDay = INVALID;             \
      }                                                                         \
    }

  const v128_t vcomma = wasm_i8x16_splat(',');
  const v128_t vnl    = wasm_i8x16_splat('\n');
  unsigned i = 0;

  for (; i + 16 <= len; i += 16) {
    v128_t chunk = wasm_v128_load(b + i);
    v128_t hit   = wasm_v128_or(wasm_i8x16_eq(chunk, vcomma), wasm_i8x16_eq(chunk, vnl));
    unsigned mask = (unsigned)wasm_i8x16_bitmask(hit);
    while (mask) {
      unsigned pos = i + (unsigned)__builtin_ctz(mask);
      mask &= mask - 1;
      EMIT(pos)
    }
  }
  for (; i < len; i++) {
    unsigned char c = b[i];
    if (c == ',' || c == '\n') EMIT(i)
  }
  #undef EMIT
  #undef FIELD
  return g_rows;
}
