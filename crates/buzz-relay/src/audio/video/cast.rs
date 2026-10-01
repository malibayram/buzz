//! Track snapshots, deltas, and keyframe requests.

use std::time::Instant;

use super::hub::Inner;
use super::msgs;
use super::types::{Occupant, TrackDesc, VideoCtrl, KEYFRAME_MIN};

impl Inner {
    pub(super) fn snapshot(&self) -> String {
        let mut peers = Vec::new();
        for ((index, epoch), occ) in &self.people {
            if occ.tracks.is_empty() {
                continue;
            }
            peers.push((
                *index,
                *epoch,
                msgs::peer_json(*index, *epoch, &occ.pubkey, &track_list(occ)),
            ));
        }
        peers.sort_by_key(|(i, e, _)| (*i, *e));
        msgs::tracks_json(
            self.revision,
            peers.into_iter().map(|(_, _, v)| v).collect(),
        )
    }

    pub(super) fn emit_delta(&mut self, index: u8, epoch: u8) {
        let Some(pubkey) = self.people.get(&(index, epoch)).map(|o| o.pubkey.clone()) else {
            return;
        };
        let tracks = self
            .people
            .get(&(index, epoch))
            .map(track_list)
            .unwrap_or_default();
        self.revision = self.revision.wrapping_add(1);
        let text = msgs::delta_json(self.revision, index, epoch, &pubkey, &tracks);
        self.fanout(&text);
    }

    pub(super) fn send_text(&self, index: u8, epoch: u8, text: String) {
        if let Some(occ) = self.people.get(&(index, epoch)) {
            let _ = occ.ctrl_tx.try_send(VideoCtrl::Text(text));
        }
    }

    pub(super) fn fanout(&mut self, text: &str) {
        let failed: Vec<(u8, u8)> = self
            .people
            .iter()
            .filter_map(|(k, occ)| {
                occ.ctrl_tx
                    .try_send(VideoCtrl::Text(text.to_string()))
                    .err()
                    .map(|_| *k)
            })
            .collect();
        for key in failed {
            self.people.remove(&key);
        }
    }

    pub(super) fn ask_keyframe(
        &mut self,
        index: u8,
        epoch: u8,
        track: u8,
        layer: u8,
        now: Instant,
    ) {
        let Some(occ) = self.people.get_mut(&(index, epoch)) else {
            return;
        };
        let due = occ
            .keyframe_at
            .get(&(track, layer))
            .is_none_or(|t| now.duration_since(*t) >= KEYFRAME_MIN);
        if !due {
            return;
        }
        if occ
            .ctrl_tx
            .try_send(VideoCtrl::Text(msgs::keyframe_request(track, layer)))
            .is_ok()
        {
            occ.keyframe_at.insert((track, layer), now);
        }
    }
}

fn track_list(occ: &Occupant) -> Vec<TrackDesc> {
    let mut tracks: Vec<_> = occ.tracks.values().cloned().collect();
    tracks.sort_by_key(|t| t.track);
    tracks
}
