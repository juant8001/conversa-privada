#!/bin/bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_DIR"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "Node.js nao encontrado."
  if command -v brew >/dev/null 2>&1; then
    echo "Instalando Node via Homebrew..."
    brew install node
    NODE_BIN="$(command -v node)"
  else
    echo "Instale o Node.js manualmente (https://nodejs.org) e rode este script de novo."
    exit 1
  fi
fi
echo "Usando Node em: $NODE_BIN"

echo "Instalando dependencias..."
npm install --omit=dev

if [ ! -f .env ]; then
  SLUG="$("$NODE_BIN" -e "console.log(require('crypto').randomBytes(20).toString('hex'))")"
  cat > .env <<EOF
PORT=4177
ROOM_SLUG=$SLUG
DATA_DIR=$PROJECT_DIR/data
MAX_UPLOAD_MB=300
EOF
  chmod 600 .env
  echo "Novo .env criado com um link (ROOM_SLUG) aleatorio."
else
  echo ".env ja existe, mantendo."
fi

mkdir -p "$PROJECT_DIR/logs" "$PROJECT_DIR/data"

PORT="$(grep '^PORT=' .env | cut -d= -f2)"
SLUG="$(grep '^ROOM_SLUG=' .env | cut -d= -f2)"

PLIST_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$PLIST_DIR"
PLIST_PATH="$PLIST_DIR/com.privatechat.server.plist"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.privatechat.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PROJECT_DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PROJECT_DIR/logs/server.out.log</string>
  <key>StandardErrorPath</key><string>$PROJECT_DIR/logs/server.err.log</string>
</dict>
</plist>
EOF

launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load -w "$PLIST_PATH"

echo ""
echo "Servidor instalado e rodando em segundo plano (reinicia sozinho com o Mac)."
echo "Link local: http://127.0.0.1:$PORT/c/$SLUG"
echo ""
echo "Para expor esse link publicamente via ngrok, rode:"
echo "  scripts/setup-ngrok.sh <seu-authtoken> <seu-dominio-fixo.ngrok-free.app>"
