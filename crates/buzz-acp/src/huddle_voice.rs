//! Membership from huddle lifecycle events. Guidelines are not membership.

use buzz_core::kind::{
    KIND_HUDDLE_ENDED, KIND_HUDDLE_PARTICIPANT_JOINED, KIND_HUDDLE_PARTICIPANT_LEFT,
    KIND_STREAM_MESSAGE,
};
use nostr::Event;

/// The audio room an agent should join.
#[derive(Debug, PartialEq, Eq)]
pub struct RoomIds {
    /// Ephemeral huddle channel.
    pub ephemeral: String,
    /// Parent channel that owns the huddle.
    pub parent: String,
}

/// What the harness should do with one relay event.
#[derive(Debug, PartialEq, Eq)]
pub enum VoiceCue {
    /// This agent was admitted.
    Join(RoomIds),
    /// This agent left, or the named room ended.
    Leave(String),
    /// Speak `text` when it was posted in `channel`.
    Speak { channel: String, text: String },
}

/// Map one event to a voice action for `self_pubkey`.
pub fn voice_cue(event: &Event, self_pubkey: &str) -> Option<VoiceCue> {
    let kind = u32::from(event.kind.as_u16());
    let author = event.pubkey.to_hex();
    match kind {
        KIND_HUDDLE_PARTICIPANT_JOINED
            if participant(event, &author).eq_ignore_ascii_case(self_pubkey) =>
        {
            Some(VoiceCue::Join(RoomIds {
                ephemeral: ephemeral_id(&event.content)?,
                parent: tag_value(event, "h")?,
            }))
        }
        KIND_HUDDLE_PARTICIPANT_LEFT
            if participant(event, &author).eq_ignore_ascii_case(self_pubkey) =>
        {
            Some(VoiceCue::Leave(ephemeral_id(&event.content)?))
        }
        KIND_HUDDLE_ENDED => Some(VoiceCue::Leave(ephemeral_id(&event.content)?)),
        KIND_STREAM_MESSAGE if author.eq_ignore_ascii_case(self_pubkey) => {
            let text = event.content.trim();
            if text.is_empty() {
                return None;
            }
            Some(VoiceCue::Speak {
                channel: tag_value(event, "h")?,
                text: text.to_string(),
            })
        }
        _ => None,
    }
}

fn participant(event: &Event, author: &str) -> String {
    tag_value(event, "p").unwrap_or_else(|| author.to_string())
}

fn tag_value(event: &Event, name: &str) -> Option<String> {
    event.tags.iter().find_map(|tag| {
        let parts = tag.as_slice();
        (parts.len() >= 2 && parts[0] == name && !parts[1].is_empty()).then(|| parts[1].clone())
    })
}

fn ephemeral_id(content: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(content).ok()?;
    let id = value.get("ephemeral_channel_id")?.as_str()?.trim();
    (!id.is_empty()).then(|| id.to_string())
}

#[cfg(test)]
mod tests {
    use nostr::{EventBuilder, Keys, Kind, Tag};

    use super::*;

    fn signed(kind: u32, content: &str, tags: Vec<Tag>, keys: &Keys) -> Event {
        EventBuilder::new(Kind::Custom(u16::try_from(kind).expect("kind")), content)
            .tags(tags)
            .sign_with_keys(keys)
            .expect("sign")
    }

    #[test]
    fn join_and_reply_belong_to_this_agent() {
        let keys = Keys::generate();
        let pubkey = keys.public_key().to_hex();
        let join = signed(
            KIND_HUDDLE_PARTICIPANT_JOINED,
            r#"{"ephemeral_channel_id":"eph"}"#,
            vec![
                Tag::parse(["h", "parent"]).expect("h"),
                Tag::parse(["p", &pubkey]).expect("p"),
            ],
            &keys,
        );
        assert!(matches!(voice_cue(&join, &pubkey), Some(VoiceCue::Join(_))));
        let said = signed(
            KIND_STREAM_MESSAGE,
            "hello",
            vec![Tag::parse(["h", "parent"]).expect("h")],
            &keys,
        );
        assert_eq!(
            voice_cue(&said, &pubkey),
            Some(VoiceCue::Speak {
                channel: "parent".into(),
                text: "hello".into()
            })
        );
        assert!(voice_cue(&said, &"ab".repeat(32)).is_none());
    }
}
