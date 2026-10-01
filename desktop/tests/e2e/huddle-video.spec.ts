import { expect, type Page, test } from "@playwright/test";

import { installFakeCamera } from "../helpers/fakeCamera";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const HUDDLE_CHANNEL_ID = "11111111-1111-4111-8111-111111111111";
const HUDDLE_PARENT_ID = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";

async function installFakeVideo(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    const host = window as Window & {
      __BUZZ_E2E_FAKE_VIDEO__?: {
        log: unknown[];
        push: (data: string) => void;
        connect: (onMessage: (data: string) => void) => {
          send: (data: string) => void;
          close: () => void;
        };
      };
    };
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
    host.__BUZZ_E2E_FAKE_VIDEO__ = {
      log: [],
      push: () => undefined,
      connect(onMessage) {
        const api = host.__BUZZ_E2E_FAKE_VIDEO__;
        if (!api) throw new Error("fake video missing");
        api.push = onMessage;
        queueMicrotask(() =>
          onMessage(JSON.stringify({ type: "challenge", challenge: "e2e" })),
        );
        return {
          send(data: string) {
            api.log.push(data);
            if (typeof data === "string" && data.includes('"type":"auth"')) {
              onMessage(
                JSON.stringify({ type: "tracks", revision: 0, peers: [] }),
              );
            }
          },
          close() {},
        };
      },
    };
  });
}

// `toBeVisible` ignores occlusion, so it passed while the stage rendered
// underneath the huddle room surface. Assert the element is what a user
// actually sees at its own center point.
async function expectOnTop(page: Page, testId: string) {
  const target = page.getByTestId(testId);
  await expect(target).toBeVisible();
  await expect
    .poll(() =>
      target.evaluate((el) => {
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

test("toggles camera and screen, then drops a remote tile", async ({
  page,
}) => {
  await installFakeCamera(page);
  await installFakeVideo(page);
  await installMockBridge(page, {
    windowLabel: `huddle-${HUDDLE_CHANNEL_ID}`,
    huddle: {
      parentChannelId: HUDDLE_PARENT_ID,
      ephemeralChannelId: HUDDLE_CHANNEL_ID,
      phase: "active",
      members: [{ pubkey: TEST_IDENTITIES.tyler.pubkey, role: "member" }],
    },
  });
  await page.goto("/");

  const camera = page.getByTestId("huddle-camera-toggle");
  await expect(camera).toBeVisible();
  await camera.click();
  await expect(camera).toHaveAttribute("aria-pressed", "true");
  await expectOnTop(page, "huddle-local-camera");

  const screen = page.getByTestId("huddle-screen-toggle");
  await screen.focus();
  await page.keyboard.press("Enter");
  await expect(screen).toHaveAttribute("aria-pressed", "true");
  await expectOnTop(page, "huddle-screen-spotlight");
  await expect(page.getByTestId("huddle-sharing-indicator")).toBeVisible();

  await page.evaluate(() => {
    const fake = (
      window as Window & {
        __BUZZ_E2E_FAKE_VIDEO__?: { push: (data: string) => void };
      }
    ).__BUZZ_E2E_FAKE_VIDEO__;
    fake?.push(JSON.stringify({ type: "error", code: "screen_share_busy" }));
  });
  await expect(page.getByTestId("huddle-video-error")).toHaveText(
    "Someone else is sharing their screen",
  );

  await page.evaluate(() => {
    const fake = (
      window as Window & {
        __BUZZ_E2E_FAKE_VIDEO__?: { push: (data: string) => void };
      }
    ).__BUZZ_E2E_FAKE_VIDEO__;
    fake?.push(
      JSON.stringify({
        type: "track_delta",
        revision: 2,
        peer_index: 4,
        epoch: 1,
        pubkey: "abc",
        tracks: [{ track: 0, codec: "avc1.42E01F", layers: [] }],
      }),
    );
  });
  await expectOnTop(page, "huddle-video-tile");
  await page.evaluate(() => {
    (
      window as Window & {
        __BUZZ_E2E_FAKE_VIDEO__?: { push: (data: string) => void };
      }
    ).__BUZZ_E2E_FAKE_VIDEO__?.push(
      JSON.stringify({
        type: "track_delta",
        revision: 3,
        peer_index: 4,
        epoch: 1,
        pubkey: "abc",
        tracks: [],
      }),
    );
  });
  await expect(page.getByTestId("huddle-video-tile")).toHaveCount(0);
});
