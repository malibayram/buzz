//! Kind 9 transcript attributed to the human `speaker` tag.

use nostr::{Event, EventBuilder, Keys, Tag};

/// Build the channel message a scribe posts after STT succeeds.
pub fn transcript_event(
    keys: &Keys,
    channel_id: &str,
    speaker: &str,
    agent_pubkeys: &[String],
    text: &str,
) -> Option<Event> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let mut tags = vec![
        Tag::parse(["h", channel_id]).ok()?,
        Tag::parse(["speaker", speaker]).ok()?,
    ];
    for pubkey in agent_pubkeys {
        tags.push(Tag::parse(["p", pubkey]).ok()?);
    }
    EventBuilder::new(nostr::Kind::Custom(9), text)
        .tags(tags)
        .sign_with_keys(keys)
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_text_is_not_a_transcript() {
        let keys = Keys::generate();
        assert!(transcript_event(&keys, "channel", "ab".repeat(32).as_str(), &[], "  ").is_none());
    }

    #[test]
    fn event_names_the_speaker_and_the_channel() {
        let keys = Keys::generate();
        let speaker = "ab".repeat(32);
        let event = transcript_event(&keys, "channel-1", &speaker, &["cd".repeat(32)], "hello")
            .expect("event");
        let tags: Vec<Vec<String>> = event.tags.iter().map(|tag| tag.clone().to_vec()).collect();
        assert!(tags
            .iter()
            .any(|tag| tag == &["h".to_string(), "channel-1".into()]));
        assert!(tags
            .iter()
            .any(|tag| tag == &["speaker".to_string(), speaker.clone()]));
        assert_eq!(event.content, "hello");
    }
}
