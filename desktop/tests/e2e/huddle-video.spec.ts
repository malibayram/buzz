import { expect, type Page, test } from "@playwright/test";

import { installFakeCamera } from "../helpers/fakeCamera";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const HUDDLE_CHANNEL_ID = "11111111-1111-4111-8111-111111111111";
const HUDDLE_PARENT_ID = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
const ALICE = TEST_IDENTITIES.alice.pubkey;
const BOB = TEST_IDENTITIES.bob.pubkey;

type FakeVideoApi = {
  log: string[];
  connects: number;
  push: (data: string) => void;
  drop: () => void;
};

async function installFakeVideo(page: Page) {
  await page.addInitScript(() => {
    const host = window as Window & { __BUZZ_E2E_FAKE_VIDEO__?: unknown };
    const media = navigator.mediaDevices ?? ({} as MediaDevices);
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: media,
      });
    }
    Object.defineProperty(media, "getDisplayMedia", {
      configurable: true,
      value: () => {
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 180;
        return Promise.resolve(canvas.captureStream(5));
      },
    });
    const api = {
      log: [] as string[],
      connects: 0,
      push: (_data: string) => undefined,
      drop: () => undefined,
      connect(onMessage: (data: string) => void, onClose?: () => void) {
        api.connects += 1;
        let open = true;
        api.push = (data: string) => {
          if (open) onMessage(data);
        };
        api.drop = () => {
          open = false;
          onClose?.();
        };
        queueMicrotask(() =>
          onMessage(JSON.stringify({ type: "challenge", challenge: "e2e" })),
        );
        return {
          send(data: string | ArrayBuffer) {
            if (typeof data !== "string") return;
            api.log.push(data);
            if (data.includes('"type":"auth"')) {
              onMessage(
                JSON.stringify({ type: "tracks", revision: 0, peers: [] }),
              );
            }
          },
          close() {
            open = false;
          },
        };
      },
    };
    host.__BUZZ_E2E_FAKE_VIDEO__ = api;
  });
}

function fake(page: Page) {
  return {
    push: (message: unknown) =>
      page.evaluate((text) => {
        (
          window as Window & { __BUZZ_E2E_FAKE_VIDEO__?: FakeVideoApi }
        ).__BUZZ_E2E_FAKE_VIDEO__?.push(text);
      }, JSON.stringify(message)),
    drop: () =>
      page.evaluate(() => {
        (
          window as Window & { __BUZZ_E2E_FAKE_VIDEO__?: FakeVideoApi }
        ).__BUZZ_E2E_FAKE_VIDEO__?.drop();
      }),
    sent: () =>
      page.evaluate(
        () =>
          (window as Window & { __BUZZ_E2E_FAKE_VIDEO__?: FakeVideoApi })
            .__BUZZ_E2E_FAKE_VIDEO__?.log ?? [],
      ),
    connects: () =>
      page.evaluate(
        () =>
          (window as Window & { __BUZZ_E2E_FAKE_VIDEO__?: FakeVideoApi })
            .__BUZZ_E2E_FAKE_VIDEO__?.connects ?? 0,
      ),
  };
}

function trackDelta(
  peerIndex: number,
  pubkey: string,
  tracks: number[],
  revision: number,
) {
  return {
    type: "track_delta",
    revision,
    peer_index: peerIndex,
    epoch: 1,
    pubkey,
    tracks: tracks.map((track) => ({
      track,
      codec: "avc1.42E01F",
      layers: [],
    })),
  };
}

// `toBeVisible` ignores occlusion, so it passed while the stage rendered
// underneath the huddle room surface. Assert the element is what a user
// actually sees at its own center point.
async function expectOnTop(locator: ReturnType<Page["locator"]>) {
  await expect(locator).toBeVisible();
  await expect
    .poll(() =>
      locator.evaluate((el) => {
        const rect = el.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return hit === el || el.contains(hit);
      }),
    )
    .toBe(true);
}

async function openHuddle(page: Page, windowLabel: string) {
  await installFakeCamera(page);
  await installFakeVideo(page);
  await installMockBridge(page, {
    windowLabel,
    huddle: {
      parentChannelId: HUDDLE_PARENT_ID,
      ephemeralChannelId: HUDDLE_CHANNEL_ID,
      phase: "active",
      members: [
        { pubkey: TEST_IDENTITIES.tyler.pubkey, role: "member" },
        { pubkey: ALICE, role: "member" },
      ],
    },
  });
  await page.goto("/");
}

test("room window: camera, presenting banner, named tiles and pinning", async ({
  page,
}) => {
  await openHuddle(page, `huddle-${HUDDLE_CHANNEL_ID}`);
  const video = fake(page);

  const camera = page.getByTestId("huddle-camera-toggle");
  await expect(camera).toBeVisible();
  await camera.click();
  await expect(camera).toHaveAttribute("aria-pressed", "true");
  await expectOnTop(page.getByTestId("huddle-local-camera"));
  await expect
    .poll(async () =>
      (await video.sent()).some((m) => m.includes('"type":"publish"')),
    )
    .toBe(true);

  // Sharing your own screen shows a banner, never a mirror of your screen.
  const screen = page.getByTestId("huddle-screen-toggle");
  await screen.focus();
  await page.keyboard.press("Enter");
  await expect(screen).toHaveAttribute("aria-pressed", "true");
  await expectOnTop(page.getByTestId("huddle-presenting-banner"));
  await expect(page.getByTestId("huddle-screen-tile")).toHaveCount(0);

  await video.push({ type: "error", code: "screen_limit" });
  await expect(page.getByTestId("huddle-video-error")).toContainText(
    "This huddle already has 4 screens shared",
  );
  await page.getByTestId("huddle-stop-presenting").click();
  await expect(screen).toHaveAttribute("aria-pressed", "false");

  // A remote camera gets a named tile and a subscription.
  await video.push(trackDelta(4, ALICE, [0], 2));
  const aliceTile = page.locator('[data-tile-key="4:1:0"]');
  await expectOnTop(aliceTile);
  await expect(aliceTile).toHaveAttribute("aria-label", /camera on/);
  await expect
    .poll(async () =>
      (await video.sent()).some(
        (m) => m.includes('"type":"subscribe"') && m.includes('"peer_index":4'),
      ),
    )
    .toBe(true);

  // Pinning switches to the presentation layout with that tile as main.
  await aliceTile.hover();
  await aliceTile.getByTestId("huddle-tile-pin").click();
  await expect(page.getByTestId("huddle-stage-presentation")).toBeVisible();

  // A screen share that starts later takes the stage once...
  await video.push(trackDelta(5, BOB, [1], 3));
  await expectOnTop(page.getByTestId("huddle-screen-tile").first());
  // ...and a pin made afterwards survives later track changes.
  await aliceTile.hover();
  await aliceTile.getByTestId("huddle-tile-pin").click();
  await video.push(trackDelta(5, BOB, [1], 4));
  await expect(aliceTile.getByTestId("huddle-tile-pin")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await video.push(trackDelta(4, ALICE, [], 5));
  await expect(aliceTile).toHaveCount(0);
});

test("several screens share at once; one goes full screen and back", async ({
  page,
}) => {
  await openHuddle(page, `huddle-${HUDDLE_CHANNEL_ID}`);
  const video = fake(page);
  await expect.poll(() => video.connects()).toBe(1);
  const fullscreenCalls = () =>
    page.evaluate(() =>
      (
        (
          window as Window & {
            __BUZZ_E2E_COMMAND_PAYLOADS__?: Array<{
              command: string;
              payload: { value?: boolean } | null;
            }>;
          }
        ).__BUZZ_E2E_COMMAND_PAYLOADS__ ?? []
      )
        .filter((entry) => entry.command === "plugin:window|set_fullscreen")
        .map((entry) => entry.payload?.value),
    );

  // Alice shares first and takes the stage; Bob's later share waits in the
  // strip instead of stealing it.
  await video.push(trackDelta(4, ALICE, [1], 2));
  const stage = page.getByTestId("huddle-stage-presentation");
  const aliceScreen = stage.locator('[data-tile-key="4:1:1"]');
  await expectOnTop(aliceScreen);
  await video.push(trackDelta(5, BOB, [1], 3));
  const strip = page.getByRole("list", { name: "Other participants" });
  await expect(strip.locator('[data-tile-key="5:1:1"]')).toBeVisible();
  await expect(aliceScreen).toHaveAttribute("aria-label", /screen/);
  await expect(strip.locator('[data-tile-key="4:1:1"]')).toHaveCount(0);

  // Full screen fills the window, and Escape leaves it.
  await aliceScreen.hover();
  await aliceScreen.getByTestId("huddle-tile-fullscreen").click();
  const fullscreen = page.getByTestId("huddle-stage-fullscreen");
  await expectOnTop(fullscreen.locator('[data-tile-key="4:1:1"]'));
  await expect(page.getByTestId("huddle-exit-fullscreen")).toBeVisible();
  await expect.poll(fullscreenCalls).toEqual([true]);
  await page.keyboard.press("Escape");
  await expect(fullscreen).toHaveCount(0);
  await expect.poll(fullscreenCalls).toEqual([true, false]);

  // Ending the share while it is full screen restores the window.
  await aliceScreen.hover();
  await aliceScreen.getByTestId("huddle-tile-fullscreen").click();
  await expect(fullscreen).toBeVisible();
  await video.push(trackDelta(4, ALICE, [], 4));
  await expect(fullscreen).toHaveCount(0);
  await expect.poll(fullscreenCalls).toEqual([true, false, true, false]);
  await expectOnTop(stage.locator('[data-tile-key="5:1:1"]'));
});

test("drawer mode shows remote video in a dock", async ({ page }) => {
  await openHuddle(page, "main");
  const video = fake(page);
  await expect.poll(() => video.connects()).toBe(1);
  await video.push(trackDelta(4, ALICE, [0], 2));
  const dock = page.getByTestId("huddle-video-dock");
  await expectOnTop(dock);
  await expect(dock.locator('[data-tile-key="4:1:0"]')).toBeVisible();
  await expect(page.getByTestId("huddle-video-dock-expand")).toBeVisible();
});

test("a dropped video socket reconnects and re-announces the camera", async ({
  page,
}) => {
  await openHuddle(page, `huddle-${HUDDLE_CHANNEL_ID}`);
  const video = fake(page);
  await page.getByTestId("huddle-camera-toggle").click();
  await expect(page.getByTestId("huddle-camera-toggle")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await video.push(trackDelta(4, ALICE, [0], 2));
  await expect(page.locator('[data-tile-key="4:1:0"]')).toBeVisible();
  const before = (await video.sent()).length;

  await video.drop();
  await expect(page.getByTestId("huddle-video-link-status")).toContainText(
    "Reconnecting",
  );
  // The stage (and the status above) stays up through the outage.
  await expect(page.locator('[data-tile-key="4:1:0"]')).toBeVisible();
  await expect.poll(() => video.connects(), { timeout: 5000 }).toBe(2);
  await expect(page.getByTestId("huddle-video-link-status")).toHaveCount(0);
  // The new socket must hear about our camera again without a toggle.
  await expect
    .poll(async () =>
      (await video.sent())
        .slice(before)
        .some((m) => m.includes('"type":"publish"')),
    )
    .toBe(true);
  // The relay re-sends the roster; tiles and subscriptions come back.
  await video.push(trackDelta(4, ALICE, [0], 3));
  await expect(page.locator('[data-tile-key="4:1:0"]')).toBeVisible();
  await expect
    .poll(async () =>
      (await video.sent())
        .slice(before)
        .some(
          (m) =>
            m.includes('"type":"subscribe"') && m.includes('"peer_index":4'),
        ),
    )
    .toBe(true);
});
