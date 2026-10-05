//! Group one speaker's 20 ms Opus frames into utterances worth transcribing.
//!
//! A frame louder than [`SPEECH_DBOV`] is speech. An utterance stays open
//! through quieter frames and closes once the speaker has been quiet for
//! [`HANGOVER`], so a breath between words does not split a sentence.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// Frames above this level count as speech.
pub const SPEECH_DBOV: i8 = -40;
/// Quiet time that ends an utterance.
pub const HANGOVER: Duration = Duration::from_millis(700);
/// Utterances with less speech than this (300 ms) are noise and are dropped.
pub const MIN_SPEECH_FRAMES: usize = 15;
/// Longest utterance (30 s). STT models degrade past this, so it is cut here.
pub const MAX_FRAMES: usize = 1_500;

/// A closed utterance ready for STT.
#[derive(Debug, PartialEq, Eq)]
pub struct Utterance {
    pub speaker: String,
    pub packets: Vec<Vec<u8>>,
}

struct Open {
    packets: Vec<Vec<u8>>,
    speech_frames: usize,
    last_speech: Instant,
}

/// Open utterances keyed by speaker pubkey.
#[derive(Default)]
pub struct Segmenter {
    open: HashMap<String, Open>,
}

impl Segmenter {
    /// Add one frame. Returns an utterance when this frame fills it.
    pub fn push(
        &mut self,
        speaker: &str,
        level_dbov: i8,
        opus: Vec<u8>,
        now: Instant,
    ) -> Option<Utterance> {
        let speech = level_dbov > SPEECH_DBOV;
        let open = match self.open.get_mut(speaker) {
            Some(open) => open,
            None if speech => self.open.entry(speaker.to_string()).or_insert(Open {
                packets: Vec::new(),
                speech_frames: 0,
                last_speech: now,
            }),
            None => return None,
        };
        open.packets.push(opus);
        if speech {
            open.speech_frames += 1;
            open.last_speech = now;
        }
        if open.packets.len() < MAX_FRAMES {
            return None;
        }
        let open = self.open.remove(speaker)?;
        close(speaker.to_string(), open)
    }

    /// Close every utterance whose speaker has been quiet for [`HANGOVER`].
    pub fn flush_quiet(&mut self, now: Instant) -> Vec<Utterance> {
        let quiet: Vec<String> = self
            .open
            .iter()
            .filter(|(_, open)| now.duration_since(open.last_speech) >= HANGOVER)
            .map(|(speaker, _)| speaker.clone())
            .collect();
        quiet
            .into_iter()
            .filter_map(|speaker| {
                let open = self.open.remove(&speaker)?;
                close(speaker, open)
            })
            .collect()
    }
}

fn close(speaker: String, open: Open) -> Option<Utterance> {
    (open.speech_frames >= MIN_SPEECH_FRAMES).then_some(Utterance {
        speaker,
        packets: open.packets,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOUD: i8 = -20;
    const QUIET: i8 = -60;
    const FRAME: Duration = Duration::from_millis(20);

    fn speak(seg: &mut Segmenter, speaker: &str, frames: usize, level: i8, t: &mut Instant) {
        for _ in 0..frames {
            assert!(seg.push(speaker, level, vec![1], *t).is_none());
            *t += FRAME;
        }
    }

    #[test]
    fn a_short_pause_does_not_split_the_utterance() {
        let mut seg = Segmenter::default();
        let mut t = Instant::now();
        speak(&mut seg, "a", 20, LOUD, &mut t);
        speak(&mut seg, "a", 10, QUIET, &mut t); // 200 ms breath
        assert!(seg.flush_quiet(t).is_empty());
        speak(&mut seg, "a", 20, LOUD, &mut t);
        let out = seg.flush_quiet(t + HANGOVER);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].packets.len(), 50);
    }

    #[test]
    fn silence_after_speech_closes_it_even_without_more_frames() {
        let mut seg = Segmenter::default();
        let mut t = Instant::now();
        speak(&mut seg, "a", 20, LOUD, &mut t);
        let last_speech = t - FRAME;
        assert!(seg.flush_quiet(last_speech + HANGOVER - FRAME).is_empty());
        assert_eq!(seg.flush_quiet(last_speech + HANGOVER).len(), 1);
    }

    #[test]
    fn a_blip_is_dropped_and_quiet_frames_alone_open_nothing() {
        let mut seg = Segmenter::default();
        let mut t = Instant::now();
        speak(&mut seg, "a", 30, QUIET, &mut t);
        speak(&mut seg, "a", MIN_SPEECH_FRAMES - 1, LOUD, &mut t);
        assert!(seg.flush_quiet(t + HANGOVER).is_empty());
    }

    #[test]
    fn speakers_are_segmented_independently() {
        let mut seg = Segmenter::default();
        let mut t = Instant::now();
        speak(&mut seg, "a", 20, LOUD, &mut t);
        let later = t + HANGOVER;
        speak(&mut seg, "b", 20, LOUD, &mut t);
        let out = seg.flush_quiet(later);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].speaker, "a");
    }

    #[test]
    fn a_long_monologue_is_cut_at_the_cap() {
        let mut seg = Segmenter::default();
        let t = Instant::now();
        for _ in 0..MAX_FRAMES - 1 {
            assert!(seg.push("a", LOUD, vec![1], t).is_none());
        }
        let cut = seg.push("a", LOUD, vec![1], t).expect("cut at cap");
        assert_eq!(cut.packets.len(), MAX_FRAMES);
        assert!(seg.flush_quiet(t + HANGOVER).is_empty());
    }
}
