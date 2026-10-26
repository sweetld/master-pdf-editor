# Master PDF Editor MCP tools

Generated from `electron/mcp-tools.cjs` by `npm run docs:mcp`; see [MCP.md](MCP.md) for setup and workflow.

Coordinates are PDF points (1/72 inch) with the origin at the top-left of the page as displayed, y downwards; `rect` = `[x0, y0, x1, y1]`. Pages are numbered from 1. `doc` (optional everywhere) is a document id, path or file name; the default is the active document.

## Documents

### `open_pdf`

Open a PDF in Master PDF Editor (starting the app if needed) and make it the active document. Returns its id, page count, page sizes and whether it has form fields. Opening a file that is already open just activates it.

| Parameter | Type | Description |
|---|---|---|
| `path` (required) | string | Absolute path of the PDF. |
| `password` | string | Password for an encrypted PDF. |

### `list_open_pdfs`

List the documents open in the app (id, name, path, pages, unsaved changes, which one is active).

### `get_document_info`

Metadata, page sizes and rotation, form field count, encryption and undo state of a document.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |

### `save_pdf`

Write the document to disk. With no output_path it overwrites the original file (a one-time &lt;name>.orig.pdf backup is made first); with output_path it writes a new file and the document then refers to it. Nothing reaches disk until you save.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `output_path` | string | Absolute path to write instead of overwriting. |

### `close_pdf`

Close a document. Refuses when it has unsaved changes unless discard_changes is true.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `discard_changes` | boolean |  Default: `false`. |

### `undo`

Undo the last change to the document (the same undo stack as Edit > Undo in the app).

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |

### `redo`

Redo the last undone change.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |

## Seeing the document

### `render_page`

Render a page to a PNG exactly as it will be saved (all pending edits applied). overlay=true draws each element's id and box; grid=true adds coordinate rulers every 50 pt for placing new content. clip renders only part of the page.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `page` (required) | integer | Page number (1-based). |
| `scale` | number | Pixels per point. Default: `1.5`. |
| `overlay` | boolean |  Default: `false`. |
| `grid` | boolean |  Default: `false`. |
| `kinds` | string[] | Limit to these kinds (default: all). |
| `clip` | number[] | [x0, y0, x1, y1] in points, origin top-left. |

### `get_page_layout`

Structure of a page: every element with its id, kind (text run, image, vector graphic, form field, annotation, added object), box and style (font, size, colour, text, field name/value, stroke). Use these ids for edits. Ids of a page's original content can change after content on it is moved or re-flowed, so re-read the layout after those.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `page` (required) | integer | Page number (1-based). |
| `kinds` | string[] | Limit to these kinds (default: all). |
| `region` | number[] | Only elements intersecting this box. |

### `get_text`

Plain text of pages (as currently in the document, before unsaved text edits are baked in).

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `pages` | integer[] | Page numbers (1-based). |

### `find_text`

Find text on the pages. Returns each matching text element (id, page, box, full text) so you can edit, delete or move it.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `query` (required) | string |  |
| `pages` | integer[] | Page numbers (1-based). |
| `case_sensitive` | boolean |  Default: `false`. |
| `regex` | boolean |  Default: `false`. |

## Deleting content

### `delete_elements`

Delete elements by id: original text, images and vector graphics are really removed from the page content when saved (not covered with white); fields, annotations and added objects are removed.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `ids` (required) | string[] | Element ids from get_page_layout / find_text. |

### `delete_region`

Delete everything (or only the given kinds) lying inside a box on a page. partial=true also deletes elements that merely intersect it.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `page` (required) | integer | Page number (1-based). |
| `rect` (required) | number[] | [x0, y0, x1, y1] in points, origin top-left. |
| `kinds` | string[] | Limit to these kinds (default: all). |
| `partial` | boolean |  Default: `false`. |

## Text

### `edit_text`

Change the wording (and optionally size, colour, font) of a text element: an original text run, an added text object, or a typewriter/callout annotation. Original text is re-set with the closest standard PDF font (Helvetica, Times or Courier family); a warning says when that differs from the original font.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `id` (required) | string |  |
| `text` (required) | string |  |
| `font_size` | number |  |
| `color` | string | Colour as #rrggbb. |
| `font` | string | Font family, e.g. Helvetica, Times, Courier. |
| `bold` | boolean |  |
| `italic` | boolean |  |

### `replace_text`

Find and replace across pages, inside each text element that contains the text. Returns how many elements changed.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `find` (required) | string |  |
| `replace` (required) | string |  |
| `pages` | integer[] | Page numbers (1-based). |
| `case_sensitive` | boolean |  Default: `true`. |
| `regex` | boolean |  Default: `false`. |

### `add_text`

Add text to a page. Give either x,y (top-left of the first line; the box fits the text) or rect (text wraps inside it). \n starts a new line.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `page` (required) | integer | Page number (1-based). |
| `text` (required) | string |  |
| `x` | number |  |
| `y` | number |  |
| `rect` | number[] | [x0, y0, x1, y1] in points, origin top-left. |
| `font` | string |  Default: `"Helvetica"`. |
| `font_size` | number |  Default: `12`. |
| `color` | string | Colour as #rrggbb. Default: `"#000000"`. |
| `bold` | boolean |  |
| `italic` | boolean |  |
| `align` | `left` \| `center` \| `right` \| `justify` |  |
| `background` | string | Colour as #rrggbb. |
| `line_height` | number | Line height as a multiple of the font size (default 1.2). |

## Graphics and annotations

### `add_image`

Place an image file (PNG, JPEG, GIF, WebP, BMP) on a page. With only x,y the image keeps its aspect ratio at 72 dpi (capped to the page); with rect it fills the box (keep_aspect fits it inside).

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `page` (required) | integer | Page number (1-based). |
| `path` (required) | string |  |
| `x` | number |  |
| `y` | number |  |
| `rect` | number[] | [x0, y0, x1, y1] in points, origin top-left. |
| `keep_aspect` | boolean |  Default: `true`. |
| `opacity` | number |  |

### `add_shape`

Draw a rectangle, ellipse or line into the page content. Lines use points [[x,y],[x,y]] (or rect corners).

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `page` (required) | integer | Page number (1-based). |
| `shape` (required) | `rect` \| `ellipse` \| `line` |  |
| `rect` | number[] | [x0, y0, x1, y1] in points, origin top-left. |
| `points` | array of [x, y] |  |
| `stroke` | string | Colour as #rrggbb. Default: `"#000000"`. |
| `fill` | string | Colour as #rrggbb. |
| `width` | number | Line width in points (0 = no outline). Default: `1`. |
| `opacity` | number |  |

### `add_annotation`

Add a comment/annotation: note (sticky note at rect top-left), typewriter (text box), highlight/underline/strikeout/squiggly (over the given rect, or over every match of `text` on the page), rect/ellipse (shape comments), stamp (e.g. APPROVED, DRAFT, CONFIDENTIAL), redact (a redaction mark; apply_redactions removes the content).

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `page` (required) | integer | Page number (1-based). |
| `type` (required) | `note` \| `typewriter` \| `highlight` \| `underline` \| `strikeout` \| `squiggly` \| `rect` \| `ellipse` \| `stamp` \| `redact` |  |
| `rect` | number[] | [x0, y0, x1, y1] in points, origin top-left. |
| `text` | string | Comment text (note/typewriter contents); for markup types without rect: the text to mark. |
| `color` | string | Colour as #rrggbb. |
| `stamp` | string | Stamp name, e.g. APPROVED. |
| `font_size` | number |  |
| `author` | string |  |

### `apply_redactions`

Apply all redaction marks in the document: the content under them is permanently removed and the area filled.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |

### `update_element`

Change an element's box or style: rect (move/resize an added object, field or annotation), color, fill, width (line width), opacity, font_size, text_color, contents (annotation text). For an original vector graphic, color/fill (null = none)/width/opacity are changed in the PDF itself, keeping its geometry and stacking order. For moving original page content use move_elements.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `id` (required) | string |  |
| `rect` | number[] | [x0, y0, x1, y1] in points, origin top-left. |
| `color` | string | Colour as #rrggbb. |
| `fill` | string \| null |  |
| `width` | number |  |
| `opacity` | number |  |
| `font_size` | number |  |
| `text_color` | string | Colour as #rrggbb. |
| `contents` | string |  |

## Re-layout

### `move_elements`

Move elements by (dx, dy) points, optionally onto another page (to_page) and/or scaled. Original text, images and vector graphics are moved exactly inside the PDF (same fonts and graphics); form fields keep their values; annotations and added objects move too. All ids must be on the same page.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `ids` (required) | string[] | Element ids from get_page_layout / find_text. |
| `dx` | number |  Default: `0`. |
| `dy` | number | Positive = down. Default: `0`. |
| `to_page` | integer | Page number (1-based). |
| `scale` | number | Scale factor about the selection's top-left (default 1). |

### `move_region`

Move everything inside a box (like move_elements on all elements in rect).

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `page` (required) | integer | Page number (1-based). |
| `rect` (required) | number[] | [x0, y0, x1, y1] in points, origin top-left. |
| `dx` | number |  Default: `0`. |
| `dy` | number |  Default: `0`. |
| `to_page` | integer | Page number (1-based). |
| `scale` | number |  |
| `partial` | boolean |  Default: `false`. |

### `flow_to_previous_page`

Re-flow a section (a boxed group of labels, fields and graphics) into the free space at the bottom of the previous page. If it doesn't all fit it is split between rows: the top part fills the gap and the rest moves up to where the section started; split boxes are closed with lines and the content below is pulled up. Give the section as ids (e.g. its box: everything inside the box is included) or as a rect. dry_run=true only reports the plan.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `page` | integer | Page the section is on (needed with rect). |
| `ids` | string[] | Element ids from get_page_layout / find_text. |
| `rect` | number[] | [x0, y0, x1, y1] in points, origin top-left. |
| `spacing` | number | Gap above the section on the previous page (default: as on its page). |
| `close_boxes` | boolean |  Default: `true`. |
| `pull_up` | boolean |  Default: `true`. |
| `dry_run` | boolean |  Default: `false`. |

## Forms

### `list_form_fields`

All form fields: id, name, type, page, box, value / checked state, options, flags.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `pages` | integer[] | Page numbers (1-based). |

### `fill_form`

Fill fields by name: text/combo/list take a string; check boxes take true/false; radio groups take the export value of the button to select.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `values` (required) | object | { "field name": value } |

### `add_form_field`

Add a form field: text, checkbox, radio, combo, list, button or signature.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `page` (required) | integer | Page number (1-based). |
| `type` (required) | `text` \| `checkbox` \| `radio` \| `combo` \| `list` \| `button` \| `signature` |  |
| `rect` (required) | number[] | [x0, y0, x1, y1] in points, origin top-left. |
| `name` | string |  |
| `value` | string \| boolean |  |
| `options` | string[] | Choices for combo/list. |
| `export_value` | string | Checkbox/radio on-value. |
| `tooltip` | string |  |
| `multiline` | boolean |  |
| `required` | boolean |  |
| `read_only` | boolean |  |
| `font_size` | number | 0 = auto. |
| `caption` | string | Button label. |

### `update_form_field`

Change a field (by id or name): rename, move/resize (rect), value, options, tooltip, flags, font size, colours.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `field` (required) | string | Field id or name. |
| `name` | string |  |
| `rect` | number[] | [x0, y0, x1, y1] in points, origin top-left. |
| `value` | string \| boolean |  |
| `options` | string[] |  |
| `tooltip` | string |  |
| `multiline` | boolean |  |
| `required` | boolean |  |
| `read_only` | boolean |  |
| `font_size` | number |  |
| `border_color` | string \| null |  |
| `fill_color` | string \| null |  |
| `text_color` | string | Colour as #rrggbb. |

### `delete_form_field`

Delete a field (by id or name; a name deletes all its widgets).

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `field` (required) | string |  |

### `flatten_form`

Flatten all form fields into static page content (values become plain text; fields are removed).

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |

## Pages

### `delete_pages`

Delete pages.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `pages` (required) | integer[] | Page numbers (1-based). |

### `move_pages`

Move pages so they start at position `to` (1-based position in the final document). Use order instead to give the complete new page order.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `pages` | integer[] | Page numbers (1-based). |
| `to` | integer |  |
| `order` | integer[] | Every page number exactly once, in the new order. |

### `insert_blank_page`

Insert blank pages after page `after` (0 = at the start; default: at the end). Size defaults to the neighbouring page.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `after` | integer |  |
| `count` | integer |  Default: `1`. |
| `width` | number |  |
| `height` | number |  |

### `duplicate_page`

Insert a copy of a page right after it.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `page` (required) | integer | Page number (1-based). |
| `copies` | integer |  Default: `1`. |

### `rotate_pages`

Rotate pages clockwise by 90, 180 or 270 degrees.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `pages` (required) | integer[] | Page numbers (1-based). |
| `degrees` (required) | `90` \| `180` \| `270` \| `-90` |  |

### `insert_pages_from_pdf`

Insert pages of another PDF (or an image file as a page) after page `after` (0 = at the start; default: at the end).

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `path` (required) | string |  |
| `pages` | integer[] | Pages of the source PDF (default: all). |
| `after` | integer |  |
| `password` | string |  |

### `crop_page`

Crop pages to a box (in the coordinates of the first listed page as displayed).

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `pages` (required) | integer[] | Page numbers (1-based). |
| `rect` (required) | number[] | [x0, y0, x1, y1] in points, origin top-left. |

### `extract_pages`

Write the given pages (with all pending edits) to a new PDF file. The open document is not changed.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `pages` (required) | integer[] | Page numbers (1-based). |
| `output_path` (required) | string |  |

## The app window

### `show_page`

Scroll the app window to a page (and optionally select elements there) so the user can see what you are working on.

| Parameter | Type | Description |
|---|---|---|
| `doc` | string | Document: its id, path or file name (default: the active document). |
| `page` (required) | integer | Page number (1-based). |
| `select` | string[] |  |

### `screenshot_app`

Screenshot of the whole Master PDF Editor window as the user sees it.
