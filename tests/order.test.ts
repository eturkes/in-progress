import { describe, expect, test } from "bun:test";
import { applyStoredOrder, moveItem, parseStoredOrder } from "../src/web/order";

const items = [
  { id: "terminal", label: "Terminal" },
  { id: "preview", label: "Preview" },
  { id: "tree", label: "Tree" },
];

describe("persistent UI ordering", () => {
  test("parses only unique string identifiers", () => {
    expect(parseStoredOrder('["preview","terminal","preview",7,null]')).toEqual([
      "preview",
      "terminal",
    ]);
    expect(parseStoredOrder(null)).toEqual([]);
    expect(parseStoredOrder("invalid json")).toEqual([]);
    expect(parseStoredOrder('{"preview":1}')).toEqual([]);
  });

  test("applies known stored identifiers and appends new items in source order", () => {
    expect(applyStoredOrder(items, ["removed", "tree", "terminal"]).map((item) => item.id)).toEqual(
      ["tree", "terminal", "preview"],
    );
  });

  test("moves an item without mutating the source", () => {
    const moved = moveItem(items, 0, 2);
    expect(moved.map((item) => item.id)).toEqual(["preview", "tree", "terminal"]);
    expect(items.map((item) => item.id)).toEqual(["terminal", "preview", "tree"]);
  });

  test("returns the source for invalid or unchanged moves", () => {
    expect(moveItem(items, 1, 1)).toBe(items);
    expect(moveItem(items, -1, 1)).toBe(items);
    expect(moveItem(items, 1, 3)).toBe(items);
  });
});
