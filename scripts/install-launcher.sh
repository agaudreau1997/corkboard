#!/bin/bash
# Adds Corkboard to the desktop's application menu (KDE, GNOME, …) for this user, with its icon:
# a .desktop entry in ~/.local/share/applications and the icon sizes in the hicolor theme. On
# Wayland the taskbar finds the window's icon through this entry (package.json's desktopName).
#
#   npm run install-launcher        (builds first)
#   bash scripts/install-launcher.sh --remove
set -euo pipefail
app_dir="$(cd "$(dirname "$0")/.." && pwd)"
apps="$HOME/.local/share/applications"
icons="$HOME/.local/share/icons/hicolor"

if [ "${1:-}" = "--remove" ]; then
  rm -f "$apps/corkboard.desktop"
  for size in 16 32 48 64 128 256 512; do rm -f "$icons/${size}x${size}/apps/corkboard.png"; done
  echo "Removed the Corkboard launcher."
  exit 0
fi

# The electron binary itself, not node_modules/.bin/electron: that is a node script, and a
# launcher started from the menu has no nvm on its PATH.
[ -f "$app_dir/out/main/index.js" ] || { echo "Build first: npm run build" >&2; exit 1; }
mkdir -p "$apps"
for size in 16 32 48 64 128 256 512; do
  src="$app_dir/build/icon-$size.png"
  [ "$size" = 512 ] && src="$app_dir/build/icon.png"
  mkdir -p "$icons/${size}x${size}/apps"
  cp "$src" "$icons/${size}x${size}/apps/corkboard.png"
done
cat > "$apps/corkboard.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Corkboard
Comment=Kanban and mind map of git-backed task boards, handed to Claude Code
Exec="$app_dir/node_modules/electron/dist/electron" "$app_dir"
Path=$app_dir
Icon=corkboard
Terminal=false
Categories=Development;ProjectManagement;
StartupWMClass=corkboard
DESKTOP
command -v update-desktop-database >/dev/null && update-desktop-database "$apps" || true
command -v kbuildsycoca6 >/dev/null && kbuildsycoca6 >/dev/null 2>&1 || true
echo "Installed $apps/corkboard.desktop"
