#!/usr/bin/env bash
# Register the slash commands. Run once, and again whenever a command's name or
# options change. Needs the bot token (not the webhook URL).
#
#   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... ./register-command.sh
#
# Global commands can take up to an hour to appear. To test immediately,
# set DISCORD_GUILD_ID to your server's id — guild commands register instantly.
#
# This PUTs the whole command set rather than POSTing each one. POST is additive:
# it creates or updates the named command and leaves everything else alone, so a
# rename (/grateful -> /gratitude) would leave the old command registered and
# still visible in the picker — where it routes to the Worker's `default:` branch
# and answers "Unknown command." PUT replaces the set outright, so the list below
# is the complete truth and anything not in it is removed.
set -euo pipefail

: "${DISCORD_APP_ID:?set DISCORD_APP_ID}"
: "${DISCORD_BOT_TOKEN:?set DISCORD_BOT_TOKEN}"

if [ -n "${DISCORD_GUILD_ID:-}" ]; then
  URL="https://discord.com/api/v10/applications/$DISCORD_APP_ID/guilds/$DISCORD_GUILD_ID/commands"
  echo "registering guild commands (instant)…"
else
  URL="https://discord.com/api/v10/applications/$DISCORD_APP_ID/commands"
  echo "registering global commands (up to 1h to propagate)…"
fi

COMMANDS='[
  {
    "name": "zettel",
    "description": "Capture a thought into the slipbox inbox",
    "options": [{
      "name": "text",
      "description": "The thought. Do not clean it up.",
      "type": 3,
      "required": true
    }]
  },
  {
    "name": "gratitude",
    "description": "Record today'"'"'s gratitude and get Arete'"'"'s reflection back",
    "options": [{
      "name": "text",
      "description": "What you are grateful for today.",
      "type": 3,
      "required": true
    }]
  },
  {
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
  }
]'

curl -fsS -X PUT "$URL" \
  -H "Authorization: Bot $DISCORD_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$COMMANDS" \
  | grep -o '"name":"[a-z]*"' | sed 's/"name":"/  ok    \//; s/"//'

echo
echo "done — the set above is now the complete list; anything else was removed"
