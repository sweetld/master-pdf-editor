#!/usr/bin/env bash
# Removes what install-linux.sh put in place.
rm -rf "$HOME/.local/opt/master-pdf-editor" "$HOME/.local/share/applications/master-pdf-editor.desktop" "$HOME/.local/share/icons/hicolor/512x512/apps/master-pdf-editor.png" "$HOME/.local/bin/master-pdf-editor"
command -v update-desktop-database >/dev/null && update-desktop-database "$HOME/.local/share/applications" || true
echo "Master PDF Editor removed."
