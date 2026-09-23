# Troubleshooting

**`extension not connected` from a tool call**: the extension is between reconnect attempts. Check `about:addons` -> Preferences -> status pill. If it says `error`, look at the background console (`about:debugging` -> Inspect on this extension -> Console). Common: token mismatch, daemon not running, port wrong.

**`Missing host permission for the tab` on `screenshot_page`**: the host permission isn't granted. Toggle "Access your data for all websites" in the extension's Permissions tab.

**Storm of "replacing extension connection" in daemon log**: an old buggy version is still running alongside a new one (two background instances both reconnecting and replacing each other). Fully quit Zen and relaunch — should resolve. If it persists, uninstall and reinstall the extension.

**Port collision**: `--port 8766` (or any other free port) on the daemon, then update the extension's options URL.

**Token rotation**: `rm ~/.config/zen-mcp/auth.token` and restart the daemon. Paste the new value into the options page.
