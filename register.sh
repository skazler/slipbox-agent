#!/usr/bin/env bash
# One-command wrapper around register-command.sh.
#
#   ./register.sh
#
# Prompts for the Mnemosyne bot token without echoing it, keeps it out of your
# shell history, and unsets it on exit. App ID and guild ID are baked in.
set -euo pipefail

cd "$(dirname "$0")"

export DISCORD_APP_ID=1530743782046171146   # Mnemosyne
export DISCORD_GUILD_ID=1510629169913139220 # Keth — guild scope registers instantly

printf 'Mnemosyne bot token (input hidden, nothing is echoed): '
read -rs DISCORD_BOT_TOKEN
printf '\n\n'
export DISCORD_BOT_TOKEN

trap 'unset DISCORD_BOT_TOKEN' EXIT

./register-command.sh
