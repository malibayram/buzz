NIP-HV
======

Huddle Video
------------

`draft` `optional`

**Depends on**: the Buzz huddle audio socket (`GET /huddle/{channel_id}/audio`)

## Abstract

Camera and screen share use a second WebSocket on the same huddle room. The
relay is a codec-opaque SFU. It does not decode H.264. Audio stays on its own
socket, and video never admits a participant who is not already a committed
audio peer.

## Protocol

The first audio peer pins the room. Video clients send `protocol_version: 4`
in the same NIP-42 auth envelope as audio. v4 audio frames are
`peer_index u8 | epoch u8 | 8-byte header | Opus`. Older clients that speak a
different version receive `upgrade_required`.

## Video frames

Client to relay, 12 bytes big-endian, then Annex-B H.264:

```text
track u8 | layer u8 | flags u8 | reserved u8 | frame_seq u32 | ts_90k u32 | Annex-B
```

`track` is 0 for camera and 1 for screen. `layer` is 0 (low) or 1 (high).
Screen uses layer 0 only. Bit 0 of `flags` marks a keyframe. The codec string
is `avc1.42E01F`. It names the Constrained Baseline profile; receivers must not
rely on its level, because a publisher may encode a screen share above 720p at
a higher level (for example `avc1.42E028`). SPS/PPS travel in-band with each
keyframe. Frames larger than 512 KB are rejected.

Relay to client prefixes that frame with `peer_index u8 | epoch u8`.

## Control

Control messages are JSON text, separate from the media queue.

Client to relay: `publish`, `unpublish`, and `subscribe` (`layer: null`
unsubscribes). Relay to client: a `tracks` snapshot on bind, then
`track_delta`, a publisher-only `keyframe_request` at least 500 ms apart per
track and layer, and `error`.

Error codes include `camera_limit` (more than 8 cameras), `screen_limit`
(more than 4 concurrent screens; a peer may replace its own), the legacy
`screen_share_busy` (older relays allowed one screen), `video_requires_audio_peer`,
`huddle_video_unavailable_on_mesh`, `huddle_video_unavailable`,
`frame_too_large`, `unsupported_version`, `unsupported_codec`, and
`invalid_publish`.

After subscribe, a layer change, or a dropped frame, the SFU skips deltas
until the next keyframe and sends `keyframe_request` when the rate limit
allows. An oversize frame tells the publisher `frame_too_large` and requests
a keyframe; the publisher must lower bitrate, because a keyframe is larger.

Each subscriber queue is small (16 frames, 768 KB) so a slow viewer drops to
the next keyframe instead of buffering seconds of video ahead of its audio.
When a camera layer-1 frame overflows that queue, the relay moves that
subscriber to layer 0 and asks for a layer-0 keyframe, so one slow viewer does
not force keyframes on every layer-1 viewer. A later `subscribe` may raise it
again.

The relay sends a WebSocket ping every 20 s and closes a socket it has read
nothing from (including pongs) for 60 s. Clients should reconnect, then
re-publish and re-subscribe, when the socket closes while the huddle is live.

## Mesh

Video is not carried on mesh datagrams. A pod that does not own the room
closes the video socket with `huddle_video_unavailable_on_mesh` before
forwarding. A single-process relay always owns the room.
