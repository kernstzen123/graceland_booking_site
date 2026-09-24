// Self-hosts the zxing-wasm binary used by the barcode-detector polyfill, so
// the scanner's backup path works offline and without the jsDelivr CDN.
// Output path is versioned to match ZXING_WASM_VERSION in src/lib/qr-scanner.ts.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(join(process.cwd(), 'package.json'));

// zxing-wasm's "exports" map hides package.json, so walk up from an exported entry.
let pkgDir = dirname(require.resolve('zxing-wasm/reader'));
while (!(existsSync(join(pkgDir, 'package.json')) && JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).name === 'zxing-wasm')) {
  const parent = dirname(pkgDir);
  if (parent === pkgDir) throw new Error('Could not locate the zxing-wasm package root');
  pkgDir = parent;
}

const { version } = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
const outDir = join(process.cwd(), 'public', 'zxing', version);

mkdirSync(outDir, { recursive: true });
copyFileSync(join(pkgDir, 'dist', 'reader', 'zxing_reader.wasm'), join(outDir, 'zxing_reader.wasm'));
console.log(`zxing_reader.wasm ${version} -> public/zxing/${version}/`);
