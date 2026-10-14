# Third-party components

This application bundles the following components. Their licences apply to those parts.

| Component | Use | Licence |
|---|---|---|
| [MuPDF](https://mupdf.com/) (WASM build, `vendor/mupdf`) | content removal, redaction, encryption, compaction | AGPL-3.0 |
| [pdf.js](https://mozilla.github.io/pdf.js/) (`vendor/pdf.min.mjs`, cmaps, standard fonts) | rendering, text extraction | Apache-2.0 |
| [pdf-lib](https://pdf-lib.js.org/) (`vendor/pdf-lib.min.js`, `node_modules/pdf-lib`) | writing annotations, forms, pages | MIT |
| [node-forge](https://github.com/digitalbazaar/forge) | PKCS#7 signatures, PKCS#12 digital IDs | BSD-3-Clause or GPL-2.0 |
| [Electron](https://www.electronjs.org/) | desktop shell | MIT |

Because MuPDF is AGPL-3.0, the application as a whole is distributed under the AGPL-3.0 (see `LICENSE`).

Master PDF Editor is a product of Code Industry Ltd. This project is an independent re-implementation written from scratch and is not affiliated with or endorsed by Code Industry. No code, icons or other assets from the original product are used.
