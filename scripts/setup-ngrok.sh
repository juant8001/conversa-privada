#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUTHTOKEN="${1:-}"
DOMAIN="${2:-}"

if [ -z "$AUTHTOKEN" ] || [ -z "$DOMAIN" ]; then
  echo "Uso: setup-ngrok.sh <authtoken> <dominio-fixo.ngrok-free.app>"
  exit 1
fi

NGROK_BIN="$(command -v ngrok || true)"
if [ -z "$NGROK_BIN" ]; then
  if command -v brew >/dev/null 2>&1; then
    echo "Instalando ngrok via Homebrew..."
    brew install ngrok
    NGROK_BIN="$(command -v ngrok)"
  else
    echo "ngrok nao encontrado e Homebrew nao disponivel. Instale manualmente: https://ngrok.com/download"
    exit 1
  fi
fi
echo "Usando ngrok em: $NGROK_BIN"

"$NGROK_BIN" config add-authtoken "$AUTHTOKEN"

if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo "Rode scripts/install.sh primeiro."
  exit 1
fi

PORT="$(grep '^PORT=' "$PROJECT_DIR/.env" | cut -d= -f2)"
SLUG="$(grep '^ROOM_SLUG=' "$PROJECT_DIR/.env" | cut -d= -f2)"

PLIST_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$PLIST_DIR"
PLIST_PATH="$PLIST_DIR/com.privatechat.ngrok.plist"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.privatechat.ngrok</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NGROK_BIN</string>
    <string>http</string>
    <string>--domain=$DOMAIN</string>
    <string>$PORT</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PROJECT_DIR/logs/ngrok.out.log</string>
  <key>StandardErrorPath</key><string>$PROJECT_DIR/logs/ngrok.err.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load -w "$PLIST_PATH"

echo ""
echo "ngrok instalado e rodando em segundo plano (reinicia sozinho com o Mac)."
echo "Link publico: https://$DOMAIN/c/$SLUG"
