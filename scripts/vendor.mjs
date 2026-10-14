// Copies the pdf.js and pdf-lib builds from node_modules into vendor/ (run after `npm install`).
import { cpSync, mkdirSync } from 'fs';
mkdirSync('vendor', { recursive: true });
cpSync('node_modules/pdfjs-dist/build/pdf.min.mjs', 'vendor/pdf.min.mjs');
cpSync('node_modules/pdfjs-dist/build/pdf.worker.min.mjs', 'vendor/pdf.worker.min.mjs');
cpSync('node_modules/pdf-lib/dist/pdf-lib.min.js', 'vendor/pdf-lib.min.js');
cpSync('node_modules/pdfjs-dist/cmaps', 'vendor/cmaps', { recursive: true });
cpSync('node_modules/pdfjs-dist/standard_fonts', 'vendor/standard_fonts', { recursive: true });
console.log('vendor/ updated');
