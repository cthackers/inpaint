import test from "node:test";
import assert from "node:assert/strict";
import { splitIgnoredDuplicateGroups, withoutDeletedDuplicates } from "../src/duplicateActions.ts";

const group = (...paths) => ({ pictures: paths.map((path) => ({ path, size: 1, modifiedMs: 2, width: 30, height: 40 })), similarity: .9 });
const paths = (groups) => groups.map((group) => group.pictures.map((picture) => picture.path));

test("late partial and final results cannot revive deleted members", () => {
  const stale = { groups: [group("a", "b", "c"), group("d", "e")], pictures: 5, partial: true };
  const deleted = new Set(["b", "e"]);
  for (const partial of [true, false]) {
    const result = withoutDeletedDuplicates({ ...stale, partial }, deleted);
    assert.deepEqual(paths(result.groups), [["a", "c"]]);
    assert.equal(result.partial, partial);
  }
  assert.deepEqual(paths(stale.groups), [["a", "b", "c"], ["d", "e"]]);
});

test("ignoring a group survives growth while new relationships stay reviewable", () => {
  assert.deepEqual(splitIgnoredDuplicateGroups([group("a", "b")], ["a\nb"]), []);
  const grown = splitIgnoredDuplicateGroups([group("a", "b", "c", "d")], ["a\nb", "c\nd"]);
  assert.deepEqual(paths(grown), [["a", "c"], ["b", "d"]]);
  assert.ok(grown.every((group) => group.similarity === .9));
});

test("ignored relationships survive split groups and unignore restores them", () => {
  const split = [group("a", "c"), group("b", "d")];
  assert.deepEqual(splitIgnoredDuplicateGroups(split, ["a\nb\nc", "b\nd"]), []);
  assert.deepEqual(paths(splitIgnoredDuplicateGroups(split, [])), [["a", "c"], ["b", "d"]]);
});

test("overlapping ignored groups never recreate any rejected pair", () => {
  const ignored = ["a\nb\nc", "b\nd", "c\ne"];
  const result = splitIgnoredDuplicateGroups([group("a", "b", "c", "d", "e", "f")], ignored);
  for (const members of paths(result)) {
    for (const key of ignored) {
      const rejected = new Set(key.split("\n"));
      assert.ok(members.filter((path) => rejected.has(path)).length <= 1);
    }
  }
  const members = paths(result).flat();
  assert.equal(new Set(members).size, members.length);
});
