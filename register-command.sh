#!/usr/bin/env bash
# Register the /note and /grateful slash commands. Run once, and again only if a
# command's name or options change. Needs the bot token (not the webhook URL).
#
#   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... ./register-command.sh
#
# Global commands can take up to an hour to appear. To test immediately,
# set DISCORD_GUILD_ID to your server's id — guild commands register instantly.
set -euo pipefail

: "${DISCORD_APP_ID:?set DISCORD_APP_ID}"
: "${DISCORD_BOT_TOKEN:?set DISCORD_BOT_TOKEN}"

if [ -n "${DISCORD_GUILD_ID:-}" ]; then
  URL="https://discord.com/api/v10/applications/$DISCORD_APP_ID/guilds/$DISCORD_GUILD_ID/commands"
  echo "registering guild command (instant)…"
else
  URL="https://discord.com/api/v10/applications/$DISCORD_APP_ID/commands"
  echo "registering global command (up to 1h to propagate)…"
fi

register() {
  curl -fsS -X POST "$URL" \
    -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$1" >/dev/null
  echo "  ok    /$2"
}

register '{
  "name": "note",
  "description": "Capture a thought into the slipbox inbox",
  "options": [{
    "name": "text",
    "description": "The thought. Do not clean it up.",
    "type": 3,
    "required": true
  }]
}' note

register '{
  "name": "grateful",
  "description": "Record today'"'"'s gratitude and get Arete'"'"'s reflection back",
  "options": [{
    "name": "text",
    "description": "What you are grateful for today.",
    "type": 3,
    "required": true
  }]
}' grateful

register '{
  "name": "reflect",
  "description": "Record the weekly reflection and get Arete'"'"'s reflection back",
  "options": [
    {
      "name": "learned",
      "description": "One thing you learned this week.",
      "type": 3,
      "required": true
    },
    {
      "name": "mistake",
      "description": "One mistake you made this week.",
      "type": 3,
      "required": true
    }
  ]
}' reflect

echo
echo "done — try /note, /grateful or /reflect in Discord"
