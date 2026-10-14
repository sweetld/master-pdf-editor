# Master PDF Editor — replica

A from-scratch re-implementation of the [Master PDF Editor](https://code-industry.net/masterpdfeditor/) workspace that runs in a browser (or in Electron). It reproduces the application's layout — main menu, the Main / Edit / View / Zoom / Find / Tools / Forms / Objects / Comments / Redaction toolbars, the Navigation Panel (Pages, Bookmarks, Attachments, Search, Object TreeView, Signatures, Layers, Comments), document tabs, pop-up notices, the Object Inspector and the status bar — and the functions behind every menu item.

Rendering is done by **pdf.js**, writing by **pdf-lib**; password security (RC4 40/128-bit, AES-128, AES-256) is implemented in `js/security.js` because pdf-lib has none. No build step: plain ES modules.

## Run

```bash
npm install && npm run vendor   # once: copies pdf.js / pdf-lib into vendor/
npm start                       # http://127.0.0.1:8765/
```

`?open=samples/sample.pdf` opens a file on load. In Chromium browsers the File System Access API is used, so **Save** writes back to the opened file and Recent Files reopen; elsewhere files are downloaded. For a desktop window: `npm i -D electron && npm run desktop`.

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

## Limitations (honest list)

* **Editing original page content** (text, images, vectors) works by covering the original with a page-coloured box and drawing the replacement; the old content stays in the file underneath. *Apply Redactions* therefore offers to rasterise the affected pages, which removes it for good.
* Edited original text is re-set in the closest standard font (Helvetica/Times/Courier families); the original embedded font is not reused.
* Items marked `*` have no engine in the browser: **OCR** and **From Scanner** show what they would need. **Email** opens the mail client but cannot attach. **Digital signatures** record the appearance and signer metadata only — no PKCS#7 signature is computed. **Convert to PDF/A** tags the file but does not validate conformance.
* Encrypted documents that use object streams cannot be rewritten (pdf-lib cannot parse them); they can still be viewed.
* Layers (optional content) can be toggled but not created.
