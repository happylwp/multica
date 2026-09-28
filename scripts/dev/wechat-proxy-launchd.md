# Host-native WeChat CONNECT proxy (launchd)

iLink bind needs the **host** TCP stack. Run this listener on the Mac, then
point the backend container at it with `MULTICA_WECHAT_HTTPS_PROXY`.

The proxy is `scripts/dev/wechat-connect-proxy.js`: CONNECT only, listen
defaults `0.0.0.0:18081`. Override with `MULTICA_WECHAT_PROXY_LISTEN` /
`MULTICA_WECHAT_PROXY_PORT`.

## One-shot (foreground)

```bash
node scripts/dev/wechat-connect-proxy.js
```

## launchd (KeepAlive)

1. Copy the plist below to `~/Library/LaunchAgents/com.multica.wechat-connect-proxy.plist`.
2. Replace `NODE` and `SCRIPT` with absolute paths (`which node`, repo checkout).
3. Load it:

```bash
launchctl load ~/Library/LaunchAgents/com.multica.wechat-connect-proxy.plist
launchctl start com.multica.wechat-connect-proxy
```

Unload:

```bash
launchctl unload ~/Library/LaunchAgents/com.multica.wechat-connect-proxy.plist
```

On newer macOS, `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.multica.wechat-connect-proxy.plist` is the equivalent of `load`.

### plist template

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.multica.wechat-connect-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>NODE</string>
    <string>SCRIPT</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/multica-wechat-connect-proxy.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/multica-wechat-connect-proxy.log</string>
</dict>
</plist>
```

## Backend wiring

In `.env` (or the wechat compose overlay):

```
MULTICA_WECHAT_HTTPS_PROXY=http://host.docker.internal:18081
```

Then:

```bash
docker compose -f docker-compose.selfhost.yml -f docker-compose.selfhost.wechat.yml up -d backend
```

Leave `MULTICA_WECHAT_HTTPS_PROXY` empty for a direct dial (macOS host binary,
or any egress that is already the native stack).
