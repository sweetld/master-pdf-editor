// Tool definitions for the Master PDF Editor MCP server (see docs/MCP.md). The stdio bridge
// (mcp.cjs) lists these; the running app implements them in js/agent.js.
// Coordinates are PDF points (1/72 inch) with the origin at the TOP-LEFT of the page as displayed,
// y growing downwards; rect = [x0, y0, x1, y1]. Pages are numbered from 1.

const DOC = { type: 'string', description: 'Document: its id, path or file name (default: the active document).' };
const PAGE = { type: 'integer', minimum: 1, description: 'Page number (1-based).' };
const PAGES = { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Page numbers (1-based).' };
const RECT = { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: '[x0, y0, x1, y1] in points, origin top-left.' };
const IDS = { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Element ids from get_page_layout / find_text.' };
const COLOR = { type: 'string', description: 'Colour as #rrggbb.' };
const KINDS = { type: 'array', items: { type: 'string', enum: ['text', 'image', 'vector', 'field', 'annot', 'object'] }, description: 'Limit to these kinds (default: all).' };

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const DEL = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const tools = [
  // ---------- documents ----------
  { group: 'Documents', name: 'open_pdf', annotations: EDIT, description: 'Open a PDF in Master PDF Editor (starting the app if needed) and make it the active document. Returns its id, page count, page sizes and whether it has form fields. Opening a file that is already open just activates it.',
    inputSchema: obj({ path: { type: 'string', description: 'Absolute path of the PDF.' }, password: { type: 'string', description: 'Password for an encrypted PDF.' } }, ['path']) },
  { group: 'Documents', name: 'list_open_pdfs', annotations: RO, description: 'List the documents open in the app (id, name, path, pages, unsaved changes, which one is active).', inputSchema: obj({}) },
  { group: 'Documents', name: 'get_document_info', annotations: RO, description: 'Metadata, page sizes and rotation, form field count, encryption and undo state of a document.', inputSchema: obj({ doc: DOC }) },
  { group: 'Documents', name: 'save_pdf', annotations: EDIT, description: 'Write the document to disk. With no output_path it overwrites the original file (a one-time <name>.orig.pdf backup is made first); with output_path it writes a new file and the document then refers to it. Nothing reaches disk until you save.',
    inputSchema: obj({ doc: DOC, output_path: { type: 'string', description: 'Absolute path to write instead of overwriting.' } }) },
  { group: 'Documents', name: 'close_pdf', annotations: DEL, description: 'Close a document. Refuses when it has unsaved changes unless discard_changes is true.', inputSchema: obj({ doc: DOC, discard_changes: { type: 'boolean', default: false } }) },
  { group: 'Documents', name: 'undo', annotations: EDIT, description: 'Undo the last change to the document (the same undo stack as Edit > Undo in the app).', inputSchema: obj({ doc: DOC }) },
  { group: 'Documents', name: 'redo', annotations: EDIT, description: 'Redo the last undone change.', inputSchema: obj({ doc: DOC }) },

  // ---------- seeing ----------
  { group: 'Seeing the document', name: 'render_page', annotations: RO, description: 'Render a page to a PNG exactly as it will be saved (all pending edits applied). overlay=true draws each element\'s id and box; grid=true adds coordinate rulers every 50 pt for placing new content. clip renders only part of the page.',
    inputSchema: obj({ doc: DOC, page: PAGE, scale: { type: 'number', minimum: 0.25, maximum: 4, default: 1.5, description: 'Pixels per point.' }, overlay: { type: 'boolean', default: false }, grid: { type: 'boolean', default: false }, kinds: KINDS, clip: RECT }, ['page']) },
  { group: 'Seeing the document', name: 'get_page_layout', annotations: RO, description: 'Structure of a page: every element with its id, kind (text run, image, vector graphic, form field, annotation, added object), box and style (font, size, colour, text, field name/value, stroke). Use these ids for edits. Ids of a page\'s original content can change after content on it is moved or re-flowed, so re-read the layout after those.',
    inputSchema: obj({ doc: DOC, page: PAGE, kinds: KINDS, region: { ...RECT, description: 'Only elements intersecting this box.' } }, ['page']) },
  { group: 'Seeing the document', name: 'get_text', annotations: RO, description: 'Plain text of pages (as currently in the document, before unsaved text edits are baked in).', inputSchema: obj({ doc: DOC, pages: PAGES }) },
  { group: 'Seeing the document', name: 'find_text', annotations: RO, description: 'Find text on the pages. Returns each matching text element (id, page, box, full text) so you can edit, delete or move it.',
    inputSchema: obj({ doc: DOC, query: { type: 'string' }, pages: PAGES, case_sensitive: { type: 'boolean', default: false }, regex: { type: 'boolean', default: false } }, ['query']) },

  // ---------- deleting ----------
  { group: 'Deleting content', name: 'delete_elements', annotations: DEL, description: 'Delete elements by id: original text, images and vector graphics are really removed from the page content when saved (not covered with white); fields, annotations and added objects are removed.', inputSchema: obj({ doc: DOC, ids: IDS }, ['ids']) },
  { group: 'Deleting content', name: 'delete_region', annotations: DEL, description: 'Delete everything (or only the given kinds) lying inside a box on a page. partial=true also deletes elements that merely intersect it.',
    inputSchema: obj({ doc: DOC, page: PAGE, rect: RECT, kinds: KINDS, partial: { type: 'boolean', default: false } }, ['page', 'rect']) },

  // ---------- text ----------
  { group: 'Text', name: 'edit_text', annotations: EDIT, description: 'Change the wording (and optionally size, colour, font) of a text element: an original text run, an added text object, or a typewriter/callout annotation. Original text is re-set with the closest standard PDF font (Helvetica, Times or Courier family); a warning says when that differs from the original font.',
    inputSchema: obj({ doc: DOC, id: { type: 'string' }, text: { type: 'string' }, font_size: { type: 'number' }, color: COLOR, font: { type: 'string', description: 'Font family, e.g. Helvetica, Times, Courier.' }, bold: { type: 'boolean' }, italic: { type: 'boolean' } }, ['id', 'text']) },
  { group: 'Text', name: 'replace_text', annotations: EDIT, description: 'Find and replace across pages, inside each text element that contains the text. Returns how many elements changed.',
    inputSchema: obj({ doc: DOC, find: { type: 'string' }, replace: { type: 'string' }, pages: PAGES, case_sensitive: { type: 'boolean', default: true }, regex: { type: 'boolean', default: false } }, ['find', 'replace']) },
  { group: 'Text', name: 'add_text', annotations: EDIT, description: 'Add text to a page. Give either x,y (top-left of the first line; the box fits the text) or rect (text wraps inside it). \\n starts a new line.',
    inputSchema: obj({ doc: DOC, page: PAGE, text: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, rect: RECT, font: { type: 'string', default: 'Helvetica' }, font_size: { type: 'number', default: 12 }, color: { ...COLOR, default: '#000000' }, bold: { type: 'boolean' }, italic: { type: 'boolean' }, align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] }, background: COLOR, line_height: { type: 'number', description: 'Line height as a multiple of the font size (default 1.2).' } }, ['page', 'text']) },

  // ---------- graphics & annotations ----------
  { group: 'Graphics and annotations', name: 'add_image', annotations: EDIT, description: 'Place an image file (PNG, JPEG, GIF, WebP, BMP) on a page. With only x,y the image keeps its aspect ratio at 72 dpi (capped to the page); with rect it fills the box (keep_aspect fits it inside).',
    inputSchema: obj({ doc: DOC, page: PAGE, path: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, rect: RECT, keep_aspect: { type: 'boolean', default: true }, opacity: { type: 'number', minimum: 0, maximum: 1 } }, ['page', 'path']) },
  { group: 'Graphics and annotations', name: 'add_shape', annotations: EDIT, description: 'Draw a rectangle, ellipse or line into the page content. Lines use points [[x,y],[x,y]] (or rect corners).',
    inputSchema: obj({ doc: DOC, page: PAGE, shape: { type: 'string', enum: ['rect', 'ellipse', 'line'] }, rect: RECT, points: { type: 'array', items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 } }, stroke: { ...COLOR, default: '#000000' }, fill: COLOR, width: { type: 'number', default: 1, description: 'Line width in points (0 = no outline).' }, opacity: { type: 'number', minimum: 0, maximum: 1 } }, ['page', 'shape']) },
  { group: 'Graphics and annotations', name: 'add_annotation', annotations: EDIT, description: 'Add a comment/annotation: note (sticky note at rect top-left), typewriter (text box), highlight/underline/strikeout/squiggly (over the given rect, or over every match of `text` on the page), rect/ellipse (shape comments), stamp (e.g. APPROVED, DRAFT, CONFIDENTIAL), redact (a redaction mark; apply_redactions removes the content).',
    inputSchema: obj({ doc: DOC, page: PAGE, type: { type: 'string', enum: ['note', 'typewriter', 'highlight', 'underline', 'strikeout', 'squiggly', 'rect', 'ellipse', 'stamp', 'redact'] }, rect: RECT, text: { type: 'string', description: 'Comment text (note/typewriter contents); for markup types without rect: the text to mark.' }, color: COLOR, stamp: { type: 'string', description: 'Stamp name, e.g. APPROVED.' }, font_size: { type: 'number' }, author: { type: 'string' } }, ['page', 'type']) },
  { group: 'Graphics and annotations', name: 'apply_redactions', annotations: DEL, description: 'Apply all redaction marks in the document: the content under them is permanently removed and the area filled.', inputSchema: obj({ doc: DOC }) },
  { group: 'Graphics and annotations', name: 'update_element', annotations: EDIT, description: 'Change an element\'s box or style: rect (move/resize an added object, field or annotation), color, fill, width (line width), opacity, font_size, text_color, contents (annotation text). For moving original page content use move_elements.',
    inputSchema: obj({ doc: DOC, id: { type: 'string' }, rect: RECT, color: COLOR, fill: { type: ['string', 'null'] }, width: { type: 'number' }, opacity: { type: 'number' }, font_size: { type: 'number' }, text_color: COLOR, contents: { type: 'string' } }, ['id']) },

  // ---------- re-layout ----------
  { group: 'Re-layout', name: 'move_elements', annotations: EDIT, description: 'Move elements by (dx, dy) points, optionally onto another page (to_page) and/or scaled. Original text, images and vector graphics are moved exactly inside the PDF (same fonts and graphics); form fields keep their values; annotations and added objects move too. All ids must be on the same page.',
    inputSchema: obj({ doc: DOC, ids: IDS, dx: { type: 'number', default: 0 }, dy: { type: 'number', default: 0, description: 'Positive = down.' }, to_page: PAGE, scale: { type: 'number', description: 'Scale factor about the selection\'s top-left (default 1).' } }, ['ids']) },
  { group: 'Re-layout', name: 'move_region', annotations: EDIT, description: 'Move everything inside a box (like move_elements on all elements in rect).',
    inputSchema: obj({ doc: DOC, page: PAGE, rect: RECT, dx: { type: 'number', default: 0 }, dy: { type: 'number', default: 0 }, to_page: PAGE, scale: { type: 'number' }, partial: { type: 'boolean', default: false } }, ['page', 'rect']) },
  { group: 'Re-layout', name: 'flow_to_previous_page', annotations: EDIT, description: 'Re-flow a section (a boxed group of labels, fields and graphics) into the free space at the bottom of the previous page. If it doesn\'t all fit it is split between rows: the top part fills the gap and the rest moves up to where the section started; split boxes are closed with lines and the content below is pulled up. Give the section as ids (e.g. its box: everything inside the box is included) or as a rect. dry_run=true only reports the plan.',
    inputSchema: obj({ doc: DOC, page: { ...PAGE, description: 'Page the section is on (needed with rect).' }, ids: IDS, rect: RECT, spacing: { type: 'number', description: 'Gap above the section on the previous page (default: as on its page).' }, close_boxes: { type: 'boolean', default: true }, pull_up: { type: 'boolean', default: true }, dry_run: { type: 'boolean', default: false } }) },

  // ---------- forms ----------
  { group: 'Forms', name: 'list_form_fields', annotations: RO, description: 'All form fields: id, name, type, page, box, value / checked state, options, flags.', inputSchema: obj({ doc: DOC, pages: PAGES }) },
  { group: 'Forms', name: 'fill_form', annotations: EDIT, description: 'Fill fields by name: text/combo/list take a string; check boxes take true/false; radio groups take the export value of the button to select.',
    inputSchema: obj({ doc: DOC, values: { type: 'object', additionalProperties: true, description: '{ "field name": value }' } }, ['values']) },
  { group: 'Forms', name: 'add_form_field', annotations: EDIT, description: 'Add a form field: text, checkbox, radio, combo, list, button or signature.',
    inputSchema: obj({ doc: DOC, page: PAGE, type: { type: 'string', enum: ['text', 'checkbox', 'radio', 'combo', 'list', 'button', 'signature'] }, rect: RECT, name: { type: 'string' }, value: { type: ['string', 'boolean'] }, options: { type: 'array', items: { type: 'string' }, description: 'Choices for combo/list.' }, export_value: { type: 'string', description: 'Checkbox/radio on-value.' }, tooltip: { type: 'string' }, multiline: { type: 'boolean' }, required: { type: 'boolean' }, read_only: { type: 'boolean' }, font_size: { type: 'number', description: '0 = auto.' }, caption: { type: 'string', description: 'Button label.' } }, ['page', 'type', 'rect']) },
  { group: 'Forms', name: 'update_form_field', annotations: EDIT, description: 'Change a field (by id or name): rename, move/resize (rect), value, options, tooltip, flags, font size, colours.',
    inputSchema: obj({ doc: DOC, field: { type: 'string', description: 'Field id or name.' }, name: { type: 'string' }, rect: RECT, value: { type: ['string', 'boolean'] }, options: { type: 'array', items: { type: 'string' } }, tooltip: { type: 'string' }, multiline: { type: 'boolean' }, required: { type: 'boolean' }, read_only: { type: 'boolean' }, font_size: { type: 'number' }, border_color: { type: ['string', 'null'] }, fill_color: { type: ['string', 'null'] }, text_color: COLOR }, ['field']) },
  { group: 'Forms', name: 'delete_form_field', annotations: DEL, description: 'Delete a field (by id or name; a name deletes all its widgets).', inputSchema: obj({ doc: DOC, field: { type: 'string' } }, ['field']) },
  { group: 'Forms', name: 'flatten_form', annotations: DEL, description: 'Flatten all form fields into static page content (values become plain text; fields are removed).', inputSchema: obj({ doc: DOC }) },

  // ---------- pages ----------
  { group: 'Pages', name: 'delete_pages', annotations: DEL, description: 'Delete pages.', inputSchema: obj({ doc: DOC, pages: PAGES }, ['pages']) },
  { group: 'Pages', name: 'move_pages', annotations: EDIT, description: 'Move pages so they start at position `to` (1-based position in the final document). Use order instead to give the complete new page order.',
    inputSchema: obj({ doc: DOC, pages: PAGES, to: { type: 'integer', minimum: 1 }, order: { ...PAGES, description: 'Every page number exactly once, in the new order.' } }) },
  { group: 'Pages', name: 'insert_blank_page', annotations: EDIT, description: 'Insert blank pages after page `after` (0 = at the start; default: at the end). Size defaults to the neighbouring page.',
    inputSchema: obj({ doc: DOC, after: { type: 'integer', minimum: 0 }, count: { type: 'integer', minimum: 1, default: 1 }, width: { type: 'number' }, height: { type: 'number' } }) },
  { group: 'Pages', name: 'duplicate_page', annotations: EDIT, description: 'Insert a copy of a page right after it.', inputSchema: obj({ doc: DOC, page: PAGE, copies: { type: 'integer', minimum: 1, default: 1 } }, ['page']) },
  { group: 'Pages', name: 'rotate_pages', annotations: EDIT, description: 'Rotate pages clockwise by 90, 180 or 270 degrees.', inputSchema: obj({ doc: DOC, pages: PAGES, degrees: { type: 'integer', enum: [90, 180, 270, -90] } }, ['pages', 'degrees']) },
  { group: 'Pages', name: 'insert_pages_from_pdf', annotations: EDIT, description: 'Insert pages of another PDF (or an image file as a page) after page `after` (0 = at the start; default: at the end).',
    inputSchema: obj({ doc: DOC, path: { type: 'string' }, pages: { ...PAGES, description: 'Pages of the source PDF (default: all).' }, after: { type: 'integer', minimum: 0 }, password: { type: 'string' } }, ['path']) },
  { group: 'Pages', name: 'crop_page', annotations: EDIT, description: 'Crop pages to a box (in the coordinates of the first listed page as displayed).', inputSchema: obj({ doc: DOC, pages: PAGES, rect: RECT }, ['pages', 'rect']) },
  { group: 'Pages', name: 'extract_pages', annotations: RO, description: 'Write the given pages (with all pending edits) to a new PDF file. The open document is not changed.', inputSchema: obj({ doc: DOC, pages: PAGES, output_path: { type: 'string' } }, ['pages', 'output_path']) },

  // ---------- the app ----------
  { group: 'The app window', name: 'show_page', annotations: RO, description: 'Scroll the app window to a page (and optionally select elements there) so the user can see what you are working on.', inputSchema: obj({ doc: DOC, page: PAGE, select: { type: 'array', items: { type: 'string' } } }, ['page']) },
  { group: 'The app window', name: 'screenshot_app', annotations: RO, description: 'Screenshot of the whole Master PDF Editor window as the user sees it.', inputSchema: obj({}) },
];

const INSTRUCTIONS = `Master PDF Editor tools: these control the running Master PDF Editor desktop app (it is started if needed), so the user sees every change live and can undo it with Edit > Undo.

Workflow:
1. open_pdf(path) -> document id, pages, sizes, form fields.
2. Look before you edit: render_page(page) shows the page exactly as it will be saved; overlay=true draws element ids, grid=true adds coordinate rulers. get_page_layout(page) lists elements with ids, boxes and styles; find_text locates text.
3. Edit with ids from get_page_layout/find_text. After move_elements, move_region or flow_to_previous_page, re-read the layout of the pages involved: ids of moved original content change.
4. Verify every meaningful change with render_page, and undo() if it is wrong. Act on warnings.
5. save_pdf(output_path=...) unless the user asked to overwrite. Overwriting makes a one-time <name>.orig.pdf backup. Nothing reaches disk until you save.

Coordinates: PDF points (1/72 inch), origin at the top-left of the page as displayed, y downwards, rect = [x0, y0, x1, y1]. Pages are numbered from 1. Most tools take an optional doc (id, path or name; default: the active document).

Prefer delete_elements/delete_region (real removal) over covering content with white shapes, move_elements/move_region for re-layout, and flow_to_previous_page to re-flow a section across a page break. Use show_page to point the user at what you changed.`;

module.exports = { tools, INSTRUCTIONS };
