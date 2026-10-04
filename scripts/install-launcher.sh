#!/bin/bash
# Adds Corkboard to the desktop's application menu (KDE, GNOME, …) for this user, with its icon:
# a .desktop entry in ~/.local/share/applications and the icon sizes in the hicolor theme. On
# Wayland the taskbar finds the window's icon through this entry (package.json's desktopName).
#
#   npm run install-launcher                          the dev checkout (builds first)
#   bash scripts/install-launcher.sh --appimage [file]  a packaged AppImage (npm run dist:linux),
#                                                     copied to ~/.local/lib/corkboard first
#   bash scripts/install-launcher.sh --remove
set -euo pipefail
app_dir="$(cd "$(dirname "$0")/.." && pwd)"
apps="$HOME/.local/share/applications"
icons="$HOME/.local/share/icons/hicolor"
installed_appimage="$HOME/.local/lib/corkboard/Corkboard.AppImage"

if [ "${1:-}" = "--remove" ]; then
  rm -f "$apps/corkboard.desktop" "$installed_appimage"
  for size in 16 32 48 64 128 256 512; do rm -f "$icons/${size}x${size}/apps/corkboard.png"; done
  echo "Removed the Corkboard launcher."
  exit 0
fi

if [ "${1:-}" = "--appimage" ]; then
  # The newest AppImage in dist/ unless a file is named. It is copied to a fixed path, so the menu
  # entry survives the next build (whose file name carries the version).
  source_file="${2:-$(ls -t "$app_dir"/dist/*.AppImage 2>/dev/null | head -1)}"
  [ -n "$source_file" ] && [ -f "$source_file" ] || { echo "No AppImage: npm run dist:linux first" >&2; exit 1; }
  mkdir -p "$(dirname "$installed_appimage")"
  cp "$source_file" "$installed_appimage"
  chmod +x "$installed_appimage"
  exec_line="\"$installed_appimage\""
  path_line=""
else
  # The electron binary itself, not node_modules/.bin/electron: that is a node script, and a
  # launcher started from the menu has no nvm on its PATH.
  [ -f "$app_dir/out/main/index.js" ] || { echo "Build first: npm run build" >&2; exit 1; }
  exec_line="\"$app_dir/node_modules/electron/dist/electron\" \"$app_dir\""
  path_line="Path=$app_dir"
fi

mkdir -p "$apps"
for size in 16 32 48 64 128 256 512; do
  src="$app_dir/build/icon-$size.png"
  [ "$size" = 512 ] && src="$app_dir/build/icon.png"
  mkdir -p "$icons/${size}x${size}/apps"
  cp "$src" "$icons/${size}x${size}/apps/corkboard.png"
done
{
  echo "[Desktop Entry]"
  echo "Type=Application"
  echo "Name=Corkboard"
  echo "Comment=Kanban and mind map of git-backed task boards, handed to Claude Code"
  echo "Exec=$exec_line"
  [ -n "$path_line" ] && echo "$path_line"
  echo "Icon=corkboard"
  echo "Terminal=false"
  echo "Categories=Development;ProjectManagement;"
  echo "StartupWMClass=corkboard"
} > "$apps/corkboard.desktop"
command -v update-desktop-database >/dev/null && update-desktop-database "$apps" || true
command -v kbuildsycoca6 >/dev/null && kbuildsycoca6 >/dev/null 2>&1 || true
echo "Installed $apps/corkboard.desktop -> ${exec_line}"
