//! Publish, subscribe, and removal. Frame forwarding lives in `forward`.

use std::time::Instant;

use super::hub::Inner;
use super::msgs;
use super::types::{Desired, TrackDesc, VideoCtrl, MAX_CAMERAS, TRACK_CAMERA, TRACK_SCREEN};

impl Inner {
    pub(super) fn generation(&self, index: u8, epoch: u8) -> Option<u64> {
        self.people.get(&(index, epoch)).map(|o| o.generation)
    }

    pub(super) fn publish(
        &mut self,
        index: u8,
        epoch: u8,
        track: u8,
        codec: String,
        layers: Vec<super::types::LayerDesc>,
    ) {
        if let Err(code) = self.publish_check(index, epoch, track) {
            self.send_text(index, epoch, msgs::error_msg(code));
            return;
        }
        if let Some(occ) = self.people.get_mut(&(index, epoch)) {
            occ.tracks.insert(
                track,
                TrackDesc {
                    track,
                    codec,
                    layers,
                },
            );
        }
        self.arm_keyframe(index, epoch, track);
        self.emit_delta(index, epoch);
    }

    pub(super) fn unpublish(&mut self, index: u8, epoch: u8, track: u8) {
        let removed = self
            .people
            .get_mut(&(index, epoch))
            .is_some_and(|occ| occ.tracks.remove(&track).is_some());
        if removed {
            self.emit_delta(index, epoch);
        }
    }

    pub(super) fn subscribe(
        &mut self,
        subscriber: (u8, u8),
        publisher: (u8, u8, u8),
        layer: Option<u8>,
        now: Instant,
    ) {
        let (sub_index, sub_epoch) = subscriber;
        let (pub_index, pub_epoch, track) = publisher;
        let Some(layer) = layer else {
            if let Some(occ) = self.people.get_mut(&(sub_index, sub_epoch)) {
                occ.desired.remove(&(pub_index, pub_epoch, track));
            }
            return;
        };
        if let Some(occ) = self.people.get_mut(&(sub_index, sub_epoch)) {
            occ.desired.insert(
                (pub_index, pub_epoch, track),
                Desired {
                    layer,
                    needs_keyframe: true,
                },
            );
        }
        self.ask_keyframe(pub_index, pub_epoch, track, layer, now);
    }

    pub(super) fn remove_occupant(&mut self, index: u8, epoch: u8) {
        let Some(occ) = self.people.remove(&(index, epoch)) else {
            return;
        };
        let _ = occ.ctrl_tx.try_send(VideoCtrl::Close);
        for other in self.people.values_mut() {
            other
                .desired
                .retain(|(pi, pe, _), _| !(*pi == index && *pe == epoch));
        }
        self.revision = self.revision.wrapping_add(1);
        let text = msgs::delta_json(self.revision, index, epoch, &occ.pubkey, &[]);
        self.fanout(&text);
    }

    fn publish_check(&self, index: u8, epoch: u8, track: u8) -> Result<(), &'static str> {
        let already = self
            .people
            .get(&(index, epoch))
            .is_some_and(|o| o.tracks.contains_key(&track));
        if track == TRACK_CAMERA && !already && self.camera_count() >= MAX_CAMERAS {
            return Err("camera_limit");
        }
        if track == TRACK_SCREEN {
            if let Some(holder) = self.screen_holder() {
                if holder != (index, epoch) {
                    return Err("screen_share_busy");
                }
            }
        }
        if track != TRACK_CAMERA && track != TRACK_SCREEN {
            return Err("invalid_publish");
        }
        Ok(())
    }

    fn camera_count(&self) -> usize {
        self.people
            .values()
            .filter(|o| o.tracks.contains_key(&TRACK_CAMERA))
            .count()
    }

    fn screen_holder(&self) -> Option<(u8, u8)> {
        self.people
            .iter()
            .find_map(|(k, o)| o.tracks.contains_key(&TRACK_SCREEN).then_some(*k))
    }

    fn arm_keyframe(&mut self, index: u8, epoch: u8, track: u8) {
        let layers: Vec<u8> = self
            .people
            .get(&(index, epoch))
            .and_then(|o| o.tracks.get(&track))
            .map(|t| t.layers.iter().map(|l| l.layer).collect())
            .unwrap_or_default();
        for other in self.people.values_mut() {
            if let Some(desired) = other.desired.get_mut(&(index, epoch, track)) {
                if layers.contains(&desired.layer) {
                    desired.needs_keyframe = true;
                }
            }
        }
    }
}
