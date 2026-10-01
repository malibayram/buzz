# Huddle scribe on a Mac mini

`buzz-voice-agent` joins one huddle audio room, sends speech to an
OpenAI-compatible `POST /v1/audio/transcriptions` endpoint, and posts a kind 9
message with a `speaker` tag. It does not require Cloudflare. A tunnel is only
one way to publish the relay. If the relay is reached through Cloudflare,
review Cloudflare's video-streaming terms before carrying camera traffic on
that hostname; the scribe itself uses the audio socket only.

Set these in the plist environment:

- `BUZZ_RELAY_URL`
- `BUZZ_PRIVATE_KEY`
- `BUZZ_HUDDLE_CHANNEL_ID` — the ephemeral huddle channel
- `BUZZ_PARENT_CHANNEL_ID`
- `BUZZ_HUDDLE_AGENTS` — comma-separated agent pubkeys to `p`-tag
- `VOICE_STT_URL`, `VOICE_TTS_URL`, `VOICE_API_KEY`
- `VOICE_STT_MODEL` (optional, default `whisper-1`)

`VOICE_TTS_URL` is reserved for harness speech. This process only transcribes.
A failed transcription is logged and is not posted. Empty text is not posted.

Install the binary, then:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>xyz.block.buzz.voice-agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/buzz-voice-agent</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>BUZZ_RELAY_URL</key>
    <string>wss://relay.example</string>
    <key>BUZZ_PRIVATE_KEY</key>
    <string></string>
    <key>BUZZ_HUDDLE_CHANNEL_ID</key>
    <string></string>
    <key>BUZZ_PARENT_CHANNEL_ID</key>
    <string></string>
    <key>VOICE_STT_URL</key>
    <string>http://127.0.0.1:8080/v1/audio/transcriptions</string>
    <key>VOICE_TTS_URL</key>
    <string>http://127.0.0.1:8080/v1/audio/speech</string>
    <key>VOICE_API_KEY</key>
    <string></string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

Load it with `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/xyz.block.buzz.voice-agent.plist`.
The same process is the `huddle-scribe` Compose service (`--profile scribe`).
