# CLAUDE.md

Master PDF Editor (replica): an Electron desktop PDF editor (pdf.js render, pdf-lib write, MuPDF WASM for
content removal and encryption; plain ES modules, no build step) with a built-in MCP server.

## When the user asks you to view or edit a PDF

Use the `master-pdf-editor` MCP tools (registered as `master-pdf-editor --mcp`), not ad-hoc scripts. They
drive the running app, so the user sees each change and can undo it:

1. `open_pdf(path)`.
2. Look first: `render_page(page)` (exactly as it will be saved); `overlay=true` shows element ids,
   `grid=true` rulers. `get_page_layout(page)` gives ids, boxes and styles; `find_text` finds text ids.
3. Edit with those ids. After `move_elements`/`move_region`/`flow_to_previous_page`, re-read the layout.
4. Verify with `render_page`; `undo` if wrong. Act on warnings.
5. `save_pdf(output_path=...)` unless told to overwrite (overwriting makes a one-time `<name>.orig.pdf`).

Prefer `delete_elements`/`delete_region` (real removal) over white boxes, and `move_*`/`flow_to_previous_page`
for re-layout. Reference: `docs/MCP.md`, `docs/MCP_TOOLS.md`.

## Developing

- `npm start` runs the app; `npm run smoke`, `npm run smoke:layout` and `npm run test:mcp` are the tests.
- MCP: schemas in `electron/mcp-tools.cjs`, implementations in `js/agent.js`, stdio bridge `electron/mcp.cjs`,
  socket host `electron/mcp-host.cjs`. After changing tools run `npm run docs:mcp`.
- The model is PDF user space (y up); MCP tools use top-left display coordinates and convert per page.
- The installed copy (`~/.local/opt/master-pdf-editor`) only changes after `npm run package:linux && npm run install:linux`.
  Bump `package.json` version and the "replica build" string in `js/dialogs.js` together.
