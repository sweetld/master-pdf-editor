// Builds runnable per-platform folders into dist/ with @electron/packager.
// Usage: node scripts/package.mjs [linux|win32|darwin|all] [x64|arm64|all]
import { packager } from '@electron/packager';
import { rmSync, existsSync } from 'fs';
const [, , plat = 'all', archArg = 'all'] = process.argv;
const targets = plat === 'all' ? [['linux', 'x64'], ['win32', 'x64'], ['darwin', 'x64'], ['darwin', 'arm64']] : (archArg === 'all' ? (plat === 'darwin' ? [['darwin', 'x64'], ['darwin', 'arm64']] : [[plat, 'x64']]) : [[plat, archArg]]);
const ignore = [/^\/node_modules\/(pdfjs-dist|mupdf|@napi-rs|\.bin|\.package-lock\.json)/, /^\/node_modules\/pdf-lib\/(es|src|ts3\.4|dist\/pdf-lib\.esm)/, /^\/node_modules\/@pdf-lib\/[^/]+\/es/, /^\/(scripts|dist|build|\.git|\.claude|\.gitignore|serve\.py|_.*|.*\.md)$/, /^\/samples\/make-sample\.mjs$/, /^\/vendor\/mupdf\/.*\.br$/, /\.map$/, /\.d\.ts$/];
for (const [platform, arch] of targets) {
  const out = `dist/${platform}-${arch}`; if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  const opts = { dir: '.', out: 'dist', platform, arch, overwrite: true, asar: { unpack: '**/*.{wasm,node}' }, ignore, appCopyright: 'Replica of Master PDF Editor, built from scratch', executableName: 'master-pdf-editor', name: 'Master PDF Editor', prune: true, quiet: false };
  if (platform === 'darwin') { opts.icon = 'build/icon'; opts.appBundleId = 'tools.daud.masterpdfeditor'; opts.appCategoryType = 'public.app-category.productivity'; opts.osxSign = undefined; }
  if (platform === 'linux') opts.icon = 'build/icon';
  if (platform === 'win32') { if (process.platform === 'win32' || process.env.WINE) { opts.icon = 'build/icon'; opts.win32metadata = { CompanyName: 'Daud', ProductName: 'Master PDF Editor', FileDescription: 'Master PDF Editor (replica)' }; } else console.log('win32: skipping exe icon/metadata (needs Wine on this host)'); }
  console.log(`packaging ${platform}-${arch}…`); const paths = await packager(opts); console.log('done:', paths);
}
