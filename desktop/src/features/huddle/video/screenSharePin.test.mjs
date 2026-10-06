import { strict as assert } from "node:assert";
import test from "node:test";

import { nextScreenSharePin } from "./screenSharePin.ts";

test("the first share takes the stage by clearing the pin", () => {
  assert.equal(
    nextScreenSharePin({
      previousScreens: [],
      screens: ["1:0:1"],
      pinnedKey: "local:camera",
    }),
    null,
  );
});

test("a second share keeps the screen being watched on stage", () => {
  assert.equal(
    nextScreenSharePin({
      previousScreens: ["2:0:1"],
      screens: ["1:0:1", "2:0:1"],
      pinnedKey: null,
    }),
    "2:0:1",
  );
});

test("a second share leaves the viewer's own pin alone", () => {
  assert.equal(
    nextScreenSharePin({
      previousScreens: ["2:0:1"],
      screens: ["2:0:1", "3:0:1"],
      pinnedKey: "4:0:0",
    }),
    "4:0:0",
  );
});

test("a share replacing the only screen takes the stage", () => {
  assert.equal(
    nextScreenSharePin({
      previousScreens: ["2:0:1"],
      screens: ["3:0:1"],
      pinnedKey: null,
    }),
    null,
  );
});

test("a share ending changes nothing", () => {
  assert.equal(
    nextScreenSharePin({
      previousScreens: ["2:0:1", "3:0:1"],
      screens: ["3:0:1"],
      pinnedKey: "3:0:1",
    }),
    "3:0:1",
  );
});
