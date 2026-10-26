// Regenerates docs/MCP_TOOLS.md from electron/mcp-tools.cjs. Usage: npm run docs:mcp
import { writeFileSync } from 'fs'; import { createRequire } from 'module';
const require = createRequire(import.meta.url); const { tools } = require('../electron/mcp-tools.cjs');
const type = s => s.enum ? s.enum.map(v => `\`${v}\``).join(' \\| ') : Array.isArray(s.type) ? s.type.join(' \\| ') : s.type === 'array' ? `${s.items?.type === 'array' ? 'array of [x, y]' : (s.items?.type || 'any') + '[]'}` : s.type || 'any';
let md = '# Master PDF Editor MCP tools\n\nGenerated from `electron/mcp-tools.cjs` by `npm run docs:mcp`; see [MCP.md](MCP.md) for setup and workflow.\n\nCoordinates are PDF points (1/72 inch) with the origin at the top-left of the page as displayed, y downwards; `rect` = `[x0, y0, x1, y1]`. Pages are numbered from 1. `doc` (optional everywhere) is a document id, path or file name; the default is the active document.\n';
let group = null;
for (const t of tools) {
  if (t.group !== group) { group = t.group; md += `\n## ${group}\n`; }
  md += `\n### \`${t.name}\`\n\n${t.description.replace(/</g, "&lt;")}\n`;
  const props = Object.entries(t.inputSchema.properties || {}); const req = new Set(t.inputSchema.required || []);
  if (props.length) { md += '\n| Parameter | Type | Description |\n|---|---|---|\n'; for (const [k, s] of props) md += `| \`${k}\`${req.has(k) ? ' (required)' : ''} | ${type(s)} | ${(s.description || '').replace(/\|/g, '\\|')}${s.default !== undefined ? ` Default: \`${JSON.stringify(s.default)}\`.` : ''} |\n`; }
}
writeFileSync(new URL('../docs/MCP_TOOLS.md', import.meta.url), md); console.log(`docs/MCP_TOOLS.md: ${tools.length} tools`);
