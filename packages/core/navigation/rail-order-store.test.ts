import { beforeEach, describe, expect, it } from "vitest";
import { RAIL_SPACES } from "../paths/spaces";
import { resolveRailOrder, useRailOrderStore } from "./rail-order-store";

describe("resolveRailOrder", () => {
  it("uses the default order until the user reorders", () => {
    expect(resolveRailOrder(null)).toEqual(RAIL_SPACES);
  });

  it("keeps a saved order", () => {
    const saved = ["chat", "work", "team", "autopilots"];
    // fork rail spaces (orchestration, assets) missing from the saved order
    // are placed after their default neighbour, like any newer space.
    expect(resolveRailOrder(saved)).toEqual([
      "chat",
      "work",
      "orchestration",
      "assets",
      "team",
      "autopilots",
    ]);
  });

  it("drops unknown and repeated ids", () => {
    expect(resolveRailOrder(["chat", "settings", 3, "chat", "work", "team", "autopilots"])).toEqual([
      "chat",
      "work",
      "orchestration",
      "assets",
      "team",
      "autopilots",
    ]);
  });

  it("drops the retired Inbox space from an order saved before it moved into Work", () => {
    expect(resolveRailOrder(["chat", "inbox", "work", "team", "autopilots"])).toEqual([
      "chat",
      "work",
      "orchestration",
      "assets",
      "team",
      "autopilots",
    ]);
  });

  it("puts a space missing from the saved order after its default neighbour", () => {
    expect(resolveRailOrder(["chat", "autopilots", "work"])).toEqual([
      "chat",
      "autopilots",
      "work",
      "orchestration",
      "assets",
      "team",
    ]);
    expect(resolveRailOrder(["chat", "team", "autopilots"])).toEqual([
      "work",
      "orchestration",
      "assets",
      "chat",
      "team",
      "autopilots",
    ]);
  });
});

describe("useRailOrderStore", () => {
  beforeEach(() => {
    useRailOrderStore.setState({ order: null });
  });

  it("saves a custom order", () => {
    // fork rail spaces missing from the order rejoin it on save.
    useRailOrderStore.getState().setOrder(["chat", "work", "team", "autopilots"]);
    expect(useRailOrderStore.getState().order).toEqual([
      "chat",
      "work",
      "orchestration",
      "assets",
      "team",
      "autopilots",
    ]);
  });

  it("forgets the order once it is back to the default", () => {
    useRailOrderStore.getState().setOrder(["team", "work", "chat", "autopilots"]);
    useRailOrderStore.getState().setOrder(RAIL_SPACES);
    expect(useRailOrderStore.getState().order).toBeNull();
  });
});
