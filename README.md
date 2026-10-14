# Master PDF Editor — replica

A from-scratch desktop re-implementation of the [Master PDF Editor](https://code-industry.net/masterpdfeditor/) workspace for Windows 10+, macOS and Linux (Electron), which also runs in a browser. It reproduces the application's layout — main menu, the Main / Edit / View / Zoom / Find / Tools / Forms / Objects / Comments / Redaction toolbars, the Navigation Panel (Pages, Bookmarks, Attachments, Search, Object TreeView, Signatures, Layers, Comments), document tabs, pop-up notices, the Object Inspector and the status bar — and the functions behind every menu item.

Rendering is done by **pdf.js**, writing by **pdf-lib**, and **MuPDF** (WASM) does what pdf-lib cannot: removing original page content, true redaction, decrypting and encrypting (RC4 40/128, AES-128, AES-256) and compacting with object streams. Digital signatures are real PKCS#7 signatures made with **node-forge**. No build step: plain ES modules, the same files on every platform, so the UI is pixel-identical.

## Run

```bash
npm install && npm run vendor   # once: copies pdf.js, pdf-lib and MuPDF into vendor/
npm start                       # desktop window (Electron)
npm run smoke                   # headless self-test, prints a JSON report
npm run web                     # browser mode on http://127.0.0.1:8765/ (fewer features)
```

Pass a PDF path on the command line to open it; drag files onto the window; the recent list reopens files by path.

## Package

```bash
npm run package                 # dist/<name>-linux-x64, -win32-x64, -darwin-x64, -darwin-arm64
npm run package:linux           # one platform at a time
```

Each `dist/…` folder is a complete, runnable application (copy it over, run `master-pdf-editor`, `Master PDF Editor.exe` or `Master PDF Editor.app`). Nothing is signed, so Windows SmartScreen and macOS Gatekeeper show a warning the first time (right-click → Open on macOS). The Windows build gets its exe icon only when packaged with Wine present.

`npm run sample` regenerates `samples/sample.pdf` (text, shapes, form fields, comments, outline).

## What is implemented

| Menu | Items |
|---|---|
| File | New (Blank, From Files, From Scanner*), Open, Reload, Recent Files, Sessions, Save, Save As, Save Optimized As, Export (pages to PNG/JPEG/BMP/TIFF, Text, Excel, CSV, Word, extract all images, PDF/A), Email, Print, System Print, Properties (Description, Security, Fonts, Initial View, Advanced), Close, Exit |
| Edit | Undo/Redo (40 levels, incl. page operations), Cut/Copy/Paste, Paste at Copy Position, Paste to Multiple Pages, Delete, Delete across pages, Select All, z-order, Align Objects (6), Set Fit to Page |
| View | Go To (first/prev/next/last/page, previous/next view), Zoom, Fit Page, Fit Width, Facing, Continuous, cover page, Grid, Snap to Grid, Replace document colors, rotate view, Find/Next/Previous, Compare, Navigation Panels, Object Inspector, Menu (F12), Full Screen (F11), Toolbars (show/hide each, settings, reset), Status Bar |
| Objects | Formatted Text, Text, Image, Line, Rectangle, Ellipse, Pencil, Place Initials — select, move, resize (handles, Shift keeps aspect), rotate (handle, Shift snaps 45°), nudge with arrows (Ctrl = 1 pt), inline text editing by double-click, edit/move/delete of the document's **existing** text, images and vector objects |
| Comments | Sticky Note (15 icons), Typewriter, Callout, Label (6 markers), Comment View (show/hide/pop-ups/delete all), Comments List (filter by type/reviewer/status, replies, status), Measurements (distance, area, perimeter with units/scale), Drawing (arrow, line, rectangle, ellipse, pencil, brush, polygon, cloud), Stamp (25 standard + custom), Highlight/Strikeout/Underline, Attach a File, Export/Import Comments (XFDF) |
| Forms | Highlight Fields, Reset Forms, Edit Tab Order, Edit Forms, Link, Text Field, Check Box, Radio Button, Combo box, List box, Button, Signature, Export/Import Form Data (FDF/XFDF); fillable with the Hand tool; actions (go to page, open file, web link, reset, show/hide, submit, JavaScript) on 10 triggers; AcroForm JavaScript subset (AFSimple_Calculate etc.) |
| Document | Insert Blank Pages, Replace, Delete, Move (dialog or drag thumbnails), Crop (dialog or draw), Page Layout, Rotate, Extract (single/separate files, bookmarks), Insert Pages (PDF, images, text), Organize Pages, Document Actions, Document JavaScript, JavaScript Console, Header and Footer (page/total/date/time/title macros), Watermark (text/image, in front/behind), Background, Bates Numbering, Page Properties (tab order, open/close actions), Redaction (mark, search and redact, apply with page rasterising), OCR*, Optimize Scanned Pages (image downsampling), Convert to Scanned Pages, Compare (pixel diff) |
| Tools | Edit Document, Edit Text, Edit Forms, Edit Images, Edit Vector Images, Select Text, Take a Snapshot (to clipboard), Hand Tool, Settings (18 tabs, persisted), Toolbar Settings, Edit Text Elements as Blocks, Certificate Manager |
| Help | Contents, Home Page, Keyboard Shortcuts, Register, Check for updates, About |

All keyboard shortcuts from the manual's Hotkeys page are bound (Ctrl+N/O/S/P/D/W, Alt+1…7 tools, Ctrl+1/2/3 page display, Ctrl+U grid, Ctrl+F/F3, Ctrl+F11 inspector, F11/F12, Ctrl+Shift+N/E/I/L/H/W/B, Ctrl+K, Ctrl+R, Ctrl+J, Ctrl+6, Ctrl+T/I/E/L, …).

Existing comments and form fields are read from the file and are editable; saving rewrites them as real PDF annotations (with appearance streams), AcroForm fields, outlines, attachments, document JavaScript and metadata, so other viewers see the result.

## Desktop features

* **Editing original content**: deleted or replaced text, images and vector objects are removed from the page content by MuPDF on save (not covered). While editing, the replacement is previewed over a page-coloured box; after Save the document is reloaded from the written file, so what you see is what is in the file.
* **Redaction** removes the text, image pixels and line art under the marks (Document → Redaction → Apply), with page rasterising still available as an alternative.
* **Encryption** of any document, including ones that use object streams; password-protected files are edited after entering the user or owner password.
* **Digital signatures**: Tools → Certificate Manager creates self-signed digital IDs (2048-bit RSA, stored as password-protected .p12 in the app data folder) or imports .p12/.pfx files; Forms → Signature signs (visible or invisible, with reason/location/contact, optional form lock); the Signatures panel's Validate checks every signature's integrity.
* **From Scanner**: SANE (`scanimage`) on Linux and macOS (`brew install sane-backends`), Windows Image Acquisition on Windows. Multi-page, resolution and colour mode, into a new document or the current one.
* **Email** composes a message with the file attached through xdg-email (Linux), Mail (macOS) or Outlook (Windows), falling back to mailto plus showing the file.
* Native open/save dialogs, saving in place, backup copies (Settings → System), print through the OS print dialog, snapshots to the clipboard.

## Limitations (honest list)

* Edited original text is re-set in the closest standard font (Helvetica/Times/Courier families); the original embedded font is not reused.
* **OCR** is not bundled (no engine was wanted); the menu item explains this. **Convert to PDF/A** tags the file but does not validate conformance. There is no virtual PDF printer (that needs a signed printer driver on Windows).
* Adding a second signature rewrites the file, which invalidates earlier signatures (incremental updates are not implemented). Self-signed IDs are not chained to a certificate authority, so other viewers show them as untrusted.
* The Windows and macOS scanner and email paths were written against the platform APIs but tested only on Linux.
* Layers (optional content) can be toggled but not created.
* In browser mode: no scanner, no cryptographic signatures, no attachments in email, and files are downloaded unless the browser offers the File System Access API.
