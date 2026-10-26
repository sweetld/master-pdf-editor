#!/usr/bin/env bash
# Installs the packaged Linux build for the current user: copies it to ~/.local/opt and adds an Applications launcher.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$HERE/dist/Master PDF Editor-linux-x64}"
DEST="$HOME/.local/opt/master-pdf-editor"
if [ ! -x "$SRC/master-pdf-editor" ]; then echo "Packaged build not found at $SRC. Run: npm run package:linux" >&2; exit 1; fi
rm -rf "$DEST"; mkdir -p "$(dirname "$DEST")"; cp -a "$SRC" "$DEST"
mkdir -p "$HOME/.local/share/icons/hicolor/512x512/apps" "$HOME/.local/share/applications" "$HOME/.local/bin"
cp "$HERE/icon.png" "$HOME/.local/share/icons/hicolor/512x512/apps/master-pdf-editor.png"
cp "$HERE/icon.png" "$DEST/icon.png"
cat > "$HOME/.local/share/applications/master-pdf-editor.desktop" <<DESK
[Desktop Entry]
Type=Application
Name=Master PDF Editor
Comment=View, edit, comment, sign and encrypt PDF documents
Exec=$DEST/master-pdf-editor %F
Icon=$DEST/icon.png
Terminal=false
Categories=Office;Viewer;
MimeType=application/pdf;
StartupWMClass=master-pdf-editor
DESK
ln -sf "$DEST/master-pdf-editor" "$HOME/.local/bin/master-pdf-editor"
# MCP server for AI agents, run by the app's binary as plain Node (no browser processes; ~100 MB instead of ~570 MB).
cat > "$HOME/.local/bin/master-pdf-editor-mcp" <<MCP
#!/bin/sh
ELECTRON_RUN_AS_NODE=1 exec "$DEST/master-pdf-editor" "$DEST/resources/app.asar/electron/mcp.cjs" "\$@"
MCP
chmod +x "$HOME/.local/bin/master-pdf-editor-mcp"
command -v update-desktop-database >/dev/null && update-desktop-database "$HOME/.local/share/applications" || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q "$HOME/.local/share/icons/hicolor" || true
echo "Installed to $DEST; launcher: ~/.local/share/applications/master-pdf-editor.desktop; commands: master-pdf-editor, master-pdf-editor-mcp (MCP server)"
