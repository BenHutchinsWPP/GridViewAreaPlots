// test_loader.mjs
//
// Shared setup for the assert-based test scripts, so they import the real
// src/*.ts modules rather than a reimplementation of them. Two jobs:
//
//   1. A Node module hook for extensionless relative imports (`./header`),
//      which are normal TypeScript and normal Vite but which Node's ESM
//      resolver rejects. Everything else — Node >= 22.6 type stripping,
//      `with { type: 'json' }` — Node already handles unaided.
//
//   2. Seeding the area axis and the grouping mapping from the SYNTHETIC
//      fixture in test_fixtures.mjs. NOTHING about a utility's areas ships in
//      the build (see src/groupings.ts): at runtime the axis is read from the
//      first CSV loaded and the mapping from a Groupings.csv the user drops. A
//      test process does neither, so without this every test sees an empty
//      axis and builds cases with zero areas — which is what silently broke
//      all three scripts when groupings.ts stopped carrying built-in data.
//
// Usage:  import './test_loader.mjs';   (must come before the src imports)

import { register } from 'node:module';

import { AREAS, groupingsCsv } from './test_fixtures.mjs';

const hooks = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve as resolvePath } from 'node:path';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\\.[a-z]+$/i.test(specifier) && context.parentURL) {
    const base = dirname(fileURLToPath(context.parentURL));
    for (const candidate of [specifier + '.ts', specifier + '/index.ts']) {
      // Rewrite the specifier and delegate, rather than short-circuiting with
      // a url of our own: only the default resolver tags the module as
      // TypeScript, and without that tag Node skips type stripping.
      if (existsSync(resolvePath(base, candidate))) return nextResolve(candidate, context);
    }
  }
  return nextResolve(specifier, context);
}
`;

register('data:text/javascript,' + encodeURIComponent(hooks), import.meta.url);

// Imported after register() so the hook is in place for groupings.ts's own
// relative imports.
const { setAxis, setGroupings } = await import('./src/groupings.ts');

// The axis order is the order ingest reads out of an export's first hour, and
// the order the cube indexes areas in.
setAxis(AREAS);
setGroupings(groupingsCsv());
