import test from "node:test";
import assert from "node:assert/strict";
import { resolveDuplicateSelection } from "../src/duplicateActions.ts";

const member = (path, keep) => ({ image: { path }, compared: { path, size: 10, modifiedMs: 20, width: 30, height: 40 }, keep, tags: [], albums: [] });
const groups = [{ members: [member("keep", true), member("delete", false)] }];

function fixture({ immich = false, fail = "", albums, marks, changed = false } = {}) {
  const calls = [];
  let removed = false;
  let active = true;
  let validations = 0;
  const store = { id: "store", immich };
  const call = async (name, args) => {
    calls.push([name, args]);
    if (name === fail) throw new Error(`Failed ${name}`);
    if (name === "duplicates_validate" && ++validations === 2 && changed) throw new Error("Keeper disappeared");
    if (["store_tags", "immich_tag_index"].includes(name)) return { delete: ["travel"] };
    if (["store_album_index", "immich_album_index"].includes(name)) return marks ?? { delete: ["Trips/Rome"] };
    if (["albums_list", "immich_albums"].includes(name)) return albums ?? [
      { id: "parent", name: "Trips", fullName: "Trips", parentId: "", isVirtual: false },
      { id: "child", name: "Rome", fullName: immich ? "Trips/Rome" : "Rome", parentId: immich ? "" : "parent", isVirtual: false },
    ];
  };
  const run = () => resolveDuplicateSelection(store, groups, call, () => active, async (paths, checks) => {
    removed = true;
    assert.deepEqual(paths, ["delete"]);
    assert.deepEqual(checks.get("delete").keepers, [groups[0].members[0].compared]);
    assert.deepEqual(checks.get("delete").expected, groups[0].members[1].compared);
    calls.push(["delete"]);
    return "Deleted";
  });
  return { calls, run, removed: () => removed, switchStore: () => { active = false; } };
}

for (const immich of [false, true]) {
  test(`metadata transfers finish before deletion (${immich ? "Immich" : "local"})`, async () => {
    const f = fixture({ immich });
    assert.equal(await f.run(), "Deleted");
    const names = f.calls.map(([name]) => name);
    assert.ok(names.indexOf(immich ? "immich_tag_paths" : "pictures_tag") < names.indexOf("delete"));
    assert.ok(names.indexOf(immich ? "immich_album_pictures_set" : "album_add") < names.indexOf("delete"));
    const album = f.calls.find(([name]) => name === (immich ? "immich_album_pictures_set" : "album_add"));
    assert.equal(album[1].id, "child");
    assert.equal(names.at(-2), "duplicates_validate");
  });
  for (const fail of immich ? ["immich_tag_index", "immich_album_index", "immich_albums", "immich_tag_paths", "immich_album_pictures_set"]
    : ["store_tags", "store_album_index", "albums_list", "pictures_tag", "album_add", "duplicates_validate"]) {
    test(`${fail} failure prevents deletion`, async () => {
      const f = fixture({ immich, fail });
      await assert.rejects(f.run(), /Failed/);
      assert.equal(f.removed(), false);
    });
  }
}

test("a missing album prevents deletion instead of silently skipping transfer", async () => {
  const f = fixture({ albums: [] });
  await assert.rejects(f.run(), /Cannot identify album/);
  assert.equal(f.removed(), false);
});

test("a keeper disappearing during metadata transfer prevents deletion", async () => {
  const f = fixture({ changed: true });
  await assert.rejects(f.run(), /Keeper disappeared/);
  assert.equal(f.removed(), false);
});

test("switching stores cancels an in-flight resolution", async () => {
  const f = fixture();
  const pending = f.run();
  f.switchStore();
  await assert.rejects(pending, /open store changed/);
  assert.equal(f.removed(), false);
});

test("new live results do not expand a deletion already selected", async () => {
  const selected = [{ members: [member("keep", true), member("delete", false)] }];
  let displayed = selected;
  const call = async (name) => {
    if (name === "duplicates_validate") {
      displayed = [{ members: [...selected[0].members, member("new-match", false)] }];
    }
    if (name === "albums_list") return [];
    return {};
  };
  await resolveDuplicateSelection({ id: "store", immich: false }, displayed, call, () => true, async (paths, checks) => {
    assert.equal(displayed[0].members.length, 3);
    assert.deepEqual(paths, ["delete"]);
    assert.equal(checks.has("new-match"), false);
    assert.deepEqual(checks.get("delete").keepers, [selected[0].members[0].compared]);
    return "Deleted";
  });
});
