# Huddle scribe on a Mac mini

`buzz-voice-agent` is a long-running scribe. It follows huddle lifecycle events
in every channel its identity belongs to. When a person joins a huddle, the
scribe joins that audio room too. It sends each speaker's utterances to an
OpenAI-compatible `POST /v1/audio/transcriptions` endpoint and posts the text as
a kind 9 message with a `speaker` tag in the huddle channel. It leaves once no
people remain, so it never keeps an empty huddle alive.

It does not require Cloudflare. A tunnel is only one way to publish the relay.
If the relay is reached through Cloudflare, review Cloudflare's video-streaming
terms before carrying camera traffic on that hostname; the scribe itself uses
the audio socket only.

## Identity and channels

Give the scribe its own key and make it a relay member:

```bash
./target/release/buzz-admin generate-key
(cd deploy/compose && ./run.sh add-member <scribe public key>)
BUZZ_PRIVATE_KEY=<scribe secret key> BUZZ_RELAY_URL=wss://relay.example \
  ./target/release/buzz users set-profile --name "Scribe"
```

Then add it to each channel whose huddles it should transcribe, for example
with `buzz channels join --channel <uuid>` under the scribe's key. The scribe
renews its subscription every minute, so channels it joins later are picked up
without a restart. A huddle that was already running when the scribe started
is joined the next time someone enters it.

## Speech-to-text endpoint

Any OpenAI-compatible transcription server works. On Apple Silicon,
whisper.cpp's server is a good local choice:

```bash
brew install whisper-cpp ffmpeg
mkdir -p ~/models
curl -L -o ~/models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
whisper-server -m ~/models/ggml-large-v3-turbo.bin -l tr \
  --host 127.0.0.1 --port 8080 \
  --inference-path /v1/audio/transcriptions --convert
```

`--convert` lets it decode the Ogg Opus the scribe sends.

## Environment

- `BUZZ_RELAY_URL` — the public community URL, e.g. `wss://relay.example`. The
  relay resolves the community from the hostname, so a loopback address fails.
- `BUZZ_PRIVATE_KEY`
- `VOICE_STT_URL`
- `VOICE_STT_MODEL` (optional, default `whisper-1`)
- `VOICE_STT_LANGUAGE` (optional, e.g. `tr`). Sent as `language`; improves
  accuracy for a known language.
- `VOICE_API_KEY` (optional) — bearer token for hosted STT.
- `BUZZ_HUDDLE_AGENTS` (optional) — comma-separated agent pubkeys. Their speech
  is not transcribed, and every transcript `p`-tags them, which wakes them on
  each line. Leave it empty for transcripts only.

An utterance closes after 700 ms of quiet, or at 30 s. Utterances with less
than 300 ms of speech are dropped. A failed transcription is logged and is not
posted. Empty text is not posted.

## launchd

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
    <key>VOICE_STT_URL</key>
    <string>http://127.0.0.1:8080/v1/audio/transcriptions</string>
    <key>VOICE_STT_LANGUAGE</key>
    <string>tr</string>
  </dict>
  <key>StandardErrorPath</key>
  <string>/tmp/buzz-voice-agent.log</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
```

Load it with `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/xyz.block.buzz.voice-agent.plist`.
The same process is the `huddle-scribe` Compose service (`--profile scribe`).
