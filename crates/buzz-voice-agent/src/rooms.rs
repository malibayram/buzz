//! Which huddle rooms the scribe should be in, from relay lifecycle events.

use buzz_core::kind::{KIND_HUDDLE_ENDED, KIND_HUDDLE_PARTICIPANT_JOINED};
use nostr::Event;

/// What one lifecycle event asks the scribe to do.
#[derive(Debug, PartialEq, Eq)]
pub enum Cue {
    /// A person joined this room; be in it too.
    Join { ephemeral: String, parent: String },
    /// The room ended.
    End { ephemeral: String },
}

/// Map a lifecycle event to a cue. Joins by the scribe itself or by one of
/// `agents` are ignored: a room with no people in it needs no transcript.
pub fn cue(event: &Event, self_pubkey: &str, agents: &[String]) -> Option<Cue> {
    let ephemeral = ephemeral_id(&event.content)?;
    match u32::from(event.kind.as_u16()) {
        KIND_HUDDLE_PARTICIPANT_JOINED => {
            let who = tag_value(event, "p")?;
            if !is_person(&who, self_pubkey, agents) {
                return None;
            }
            Some(Cue::Join {
                ephemeral,
                parent: tag_value(event, "h")?,
            })
        }
        KIND_HUDDLE_ENDED => Some(Cue::End { ephemeral }),
        _ => None,
    }
}

/// Whether `pubkey` is a person rather than this scribe or a known agent.
pub fn is_person(pubkey: &str, self_pubkey: &str, agents: &[String]) -> bool {
    !pubkey.eq_ignore_ascii_case(self_pubkey)
        && !agents
            .iter()
            .any(|agent| agent.eq_ignore_ascii_case(pubkey))
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

    fn lifecycle(kind: u32, who: &str) -> Event {
        EventBuilder::new(
            Kind::Custom(u16::try_from(kind).expect("kind")),
            r#"{"ephemeral_channel_id":"eph"}"#,
        )
        .tags(vec![
            Tag::parse(["h", "parent"]).expect("h"),
            Tag::parse(["p", who]).expect("p"),
        ])
        .sign_with_keys(&Keys::generate())
        .expect("sign")
    }

    #[test]
    fn a_person_joining_pulls_the_scribe_in() {
        let me = "aa".repeat(32);
        let person = "bb".repeat(32);
        assert_eq!(
            cue(
                &lifecycle(KIND_HUDDLE_PARTICIPANT_JOINED, &person),
                &me,
                &[]
            ),
            Some(Cue::Join {
                ephemeral: "eph".into(),
                parent: "parent".into()
            })
        );
    }

    #[test]
    fn the_scribe_or_an_agent_joining_does_not() {
        let me = "aa".repeat(32);
        let agent = "cc".repeat(32);
        let agents = [agent.to_uppercase()];
        assert!(cue(
            &lifecycle(KIND_HUDDLE_PARTICIPANT_JOINED, &me),
            &me,
            &agents
        )
        .is_none());
        assert!(cue(
            &lifecycle(KIND_HUDDLE_PARTICIPANT_JOINED, &agent),
            &me,
            &agents
        )
        .is_none());
    }

    #[test]
    fn an_ended_room_is_left() {
        let me = "aa".repeat(32);
        assert_eq!(
            cue(&lifecycle(KIND_HUDDLE_ENDED, &me), &me, &[]),
            Some(Cue::End {
                ephemeral: "eph".into()
            })
        );
    }
}
