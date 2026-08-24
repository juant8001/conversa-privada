#!/bin/bash
set -euo pipefail

PLIST_DIR="$HOME/Library/LaunchAgents"

for label in com.privatechat.server com.privatechat.ngrok; do
  PLIST_PATH="$PLIST_DIR/$label.plist"
  if [ -f "$PLIST_PATH" ]; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    echo "Removido: $label"
  fi
done

echo "Servicos parados. Os arquivos do projeto (incluindo os dados criptografados) NAO foram apagados."
