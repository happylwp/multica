import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assessHeadroom, findDuplicateNumbers, migrationNumber } from "./check-fork-migration-guard.mjs";

const script = fileURLToPath(new URL("./check-fork-migration-guard.mjs", import.meta.url));

test("migrationNumber parses the numeric prefix", () => {
  assert.equal(migrationNumber("900_asset_profile"), 900);
  assert.equal(migrationNumber("129_x"), 129);
  assert.equal(migrationNumber("init"), null);
});

test("duplicate numbers below 129 are exempt", () => {
  assert.deepEqual(findDuplicateNumbers(["100_main", "100_fork", "128_a", "128_b", "129_x"]), []);
});

test("the exemption boundary is exact: 128 exempt, 129 collides", () => {
  assert.deepEqual(findDuplicateNumbers(["128_a", "128_b"]), []);
  assert.deepEqual(findDuplicateNumbers(["129_a", "129_b", "900_solo"]), [
    { number: 129, stems: ["129_a", "129_b"] },
  ]);
});

test("duplicates list every stem under its number", () => {
  assert.deepEqual(findDuplicateNumbers(["900_asset_profile", "753_upstream", "900_upstream", "901_solo"]), [
    { number: 900, stems: ["900_asset_profile", "900_upstream"] },
  ]);
});

test("an up/down pair counts once because the version key is the stem", () => {
  // The CLI derives stems from .up.sql files only; a stem repeated in the
  // input (modelling its .down.sql twin) must not collide with itself.
  assert.deepEqual(findDuplicateNumbers(["900_asset_profile", "900_asset_profile", "901_solo"]), []);
});

test("headroom is quiet while the margin covers the threshold", () => {
  const headroom = assessHeadroom({
    upstreamStems: ["753_shared", "880_top"],
    forkStems: ["753_shared", "900_asset_profile", "904_asset_profile_workspace_name_uidx"],
    threshold: 20,
  });
  assert.equal(headroom.applicable, true);
  assert.equal(headroom.upstreamMax, 880);
  assert.equal(headroom.margin, 20);
  assert.equal(headroom.warn, false);
  assert.deepEqual(headroom.overlap, []);
});

test("headroom warns strictly below the threshold", () => {
  const headroom = assessHeadroom({
    upstreamStems: ["881_top"],
    forkStems: ["900_asset_profile", "904_asset_profile_workspace_name_uidx"],
    threshold: 20,
  });
  assert.equal(headroom.margin, 19);
  assert.equal(headroom.warn, true);
  assert.deepEqual(headroom.overlap, []);
});

test("upstream landing exactly on the reserved floor collides and warns even at --margin 0", () => {
  const headroom = assessHeadroom({
    upstreamStems: ["900_upstream_arrived"],
    forkStems: ["900_asset_profile", "904_asset_profile_workspace_name_uidx"],
    threshold: 0,
  });
  assert.equal(headroom.margin, 0);
  assert.deepEqual(headroom.overlap, [900]);
  assert.equal(headroom.warn, true, "warn must hold whenever a collision exists, independent of the threshold");
});

test("an upstream number past the whole range without landing in it is no collision", () => {
  const headroom = assessHeadroom({
    upstreamStems: ["899_last_below", "950_skipped_past"],
    forkStems: ["900_asset_profile", "904_asset_profile_workspace_name_uidx"],
    threshold: 20,
  });
  assert.equal(headroom.margin, -50);
  assert.deepEqual(headroom.overlap, [], "numbering skipped over the range; nothing actually collides yet");
  assert.equal(headroom.warn, true, "a negative margin still warns at the default threshold");
});

test("the reserved series ignores inherited and upstream-owned asset_profile stems", () => {
  const headroom = assessHeadroom({
    upstreamStems: ["100_asset_profile_legacy", "754_asset_profile_sync", "754_other"],
    forkStems: ["100_asset_profile_legacy", "754_asset_profile_sync", "900_asset_profile", "901_asset_profile_id_uidx"],
    threshold: 20,
  });
  assert.deepEqual(
    headroom.renumberMap.map(({ stem }) => stem),
    ["900_asset_profile", "901_asset_profile_id_uidx"],
    "below-129 and upstream-owned stems must not be renumber targets",
  );
  assert.equal(headroom.reservedFloor, 900);
  assert.equal(headroom.margin, 900 - 754);
});

test("the renumber map starts one past the higher side", () => {
  const headroom = assessHeadroom({
    upstreamStems: ["885_top"],
    forkStems: ["753_shared", "900_asset_profile", "901_asset_profile_id_uidx", "902_asset_profile_pkey"],
    threshold: 20,
  });
  assert.deepEqual(
    headroom.renumberMap.map(({ from, to }) => [from, to]),
    [
      [900, 903],
      [901, 904],
      [902, 905],
    ],
  );

  const overtaken = assessHeadroom({
    upstreamStems: ["905_upstream_takeover", "910_top"],
    forkStems: ["900_asset_profile", "901_asset_profile_id_uidx"],
    threshold: 20,
  });
  assert.deepEqual(headroom.upstreamMax, 885);
  assert.deepEqual(overtaken.overlap, [], "905 and 910 sit above the 900-901 range, so nothing collides yet");
  assert.deepEqual(
    overtaken.renumberMap.map(({ from, to }) => [from, to]),
    [
      [900, 911],
      [901, 912],
    ],
  );
});

test("headroom is not applicable without the reserved series or without upstream migrations", () => {
  assert.equal(assessHeadroom({ upstreamStems: ["753_shared"], forkStems: ["753_shared", "904_other"], threshold: 20 }).applicable, false);
  assert.equal(assessHeadroom({ upstreamStems: [], forkStems: ["900_asset_profile"], threshold: 20 }).applicable, false);
});

const cli = (t, repoSetup) => {
  const dir = mkdtempSync(join(tmpdir(), "fork-migration-guard-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "CI test", GIT_AUTHOR_EMAIL: "ci@example.invalid",
    GIT_COMMITTER_NAME: "CI test", GIT_COMMITTER_EMAIL: "ci@example.invalid",
  };
  delete env.GITHUB_ACTIONS;
  const git = (...args) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const migrations = join(dir, "server", "migrations");
  const addMigration = (stem) => {
    writeFileSync(join(migrations, `${stem}.up.sql`), `-- ${stem}\n`);
    writeFileSync(join(migrations, `${stem}.down.sql`), `-- ${stem}\n`);
  };
  const commit = (message) => {
    git("add", ".");
    git("commit", "-m", message);
  };
  const run = (...args) => spawnSync("node", [script, ...args], { cwd: dir, env, encoding: "utf8" });

  mkdirSync(migrations, { recursive: true });
  git("init", "-b", "main");
  repoSetup({ git, addMigration, commit, dir });

  return run;
};

test("the CLI passes on a clean fork ref and warns without failing", (t) => {
  const run = cli(t, ({ git, addMigration, commit }) => {
    addMigration("718_shared");
    addMigration("100_a");
    addMigration("100_b"); // exempt duplicate below 129
    addMigration("900_asset_profile");
    addMigration("901_asset_profile_id_uidx");
    commit("fork main");
    git("checkout", "-b", "upstream-main");
    git("rm", "-q", "server/migrations/900_asset_profile.up.sql", "server/migrations/900_asset_profile.down.sql",
      "server/migrations/901_asset_profile_id_uidx.up.sql", "server/migrations/901_asset_profile_id_uidx.down.sql",
      "server/migrations/100_a.up.sql", "server/migrations/100_a.down.sql",
      "server/migrations/100_b.up.sql", "server/migrations/100_b.down.sql");
    addMigration("753_top");
    commit("upstream main");
    git("checkout", "main");
  });

  const clear = run("--ref", "main", "--upstream", "upstream-main", "--margin", "20");
  assert.equal(clear.status, 0);
  assert.match(clear.stdout, /unique on main \(5 migrations, max 901\)/);
  assert.equal(clear.stderr, "");

  const warning = run("--ref", "main", "--upstream", "upstream-main", "--margin", "150");
  assert.equal(warning.status, 0, "a headroom warning must not fail the run");
  assert.match(warning.stderr, /headroom to the reserved floor 900 is 147 \(threshold 150\)/);
  assert.match(warning.stderr, /900_asset_profile: 900 -> 902/);
  assert.match(warning.stdout, /unique on main/);
});

test("the CLI fails on a duplicate number and stays machine-readable in --json mode", (t) => {
  const run = cli(t, ({ addMigration, commit }) => {
    addMigration("718_shared");
    addMigration("900_asset_profile");
    commit("fork main");
    addMigration("900_upstream_arrived");
    commit("sync brought a same-numbered migration");
  });

  const failed = run("--ref", "main", "--upstream", "main");
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /Migration number 900 is used by 2 migrations on main: 900_asset_profile, 900_upstream_arrived/);
  assert.match(failed.stderr, /1 migration number\(s\) collide on main/);

  const asJson = run("--ref", "main", "--upstream", "main", "--json");
  assert.equal(asJson.status, 1, "--json keeps the collision exit code");
  const payload = JSON.parse(asJson.stdout);
  assert.deepEqual(payload.duplicates, [{ number: 900, stems: ["900_asset_profile", "900_upstream_arrived"] }]);
});

test("the CLI reports an exact overlap as a WILL-collide warning with a renumber map", (t) => {
  const run = cli(t, ({ git, addMigration, commit }) => {
    addMigration("718_shared");
    addMigration("900_asset_profile");
    addMigration("901_asset_profile_id_uidx");
    commit("fork main");
    git("checkout", "-b", "upstream-main");
    git("rm", "-q", "server/migrations/900_asset_profile.up.sql", "server/migrations/900_asset_profile.down.sql",
      "server/migrations/901_asset_profile_id_uidx.up.sql", "server/migrations/901_asset_profile_id_uidx.down.sql");
    addMigration("901_upstream_takeover");
    commit("upstream landed inside the range");
    git("checkout", "main");
  });

  const result = run("--ref", "main", "--upstream", "upstream-main");
  assert.equal(result.status, 0, "an overlap warns but does not fail; the collision check owns failure");
  assert.match(result.stderr, /number\(s\) 901 inside the fork's reserved range 900-901; the next upstream sync WILL collide/);
  assert.match(result.stderr, /900_asset_profile: 900 -> 902/);

  const asJson = run("--ref", "main", "--upstream", "upstream-main", "--json", "--margin", "150");
  assert.equal(asJson.status, 0);
  assert.equal(asJson.stderr, "", "--json keeps stdout machine-parseable and emits no warning text");
  const payload = JSON.parse(asJson.stdout);
  assert.deepEqual(payload.duplicates, []);
  assert.equal(payload.headroom.upstreamMax, 901);
  assert.deepEqual(payload.headroom.overlap, [901]);
  assert.deepEqual(
    payload.headroom.renumberMap.map(({ from, to }) => [from, to]),
    [
      [900, 902],
      [901, 903],
    ],
  );
});

test("the CLI exits 2 on an unreadable ref, a bad threshold, or an empty migration set", (t) => {
  const run = cli(t, ({ git, addMigration, commit, dir }) => {
    addMigration("900_asset_profile");
    commit("fork main");
    git("checkout", "--orphan", "empty-history");
    git("rm", "-qrf", ".");
    writeFileSync(join(dir, "README.md"), "a ref with no migrations at all\n");
    git("add", "README.md");
    commit("empty history");
    git("checkout", "main");
  });

  assert.equal(run("--ref", "missing-ref").status, 2);
  const badThreshold = run("--ref", "main", "--upstream", "main", "--margin", "soon");
  assert.equal(badThreshold.status, 2);
  assert.match(badThreshold.stderr, /Invalid --margin threshold: NaN/);
  const negative = run("--ref", "main", "--upstream", "main", "--margin", "-5");
  assert.equal(negative.status, 2);
  assert.match(negative.stderr, /Invalid --margin threshold: -5/);
  const empty = run("--ref", "empty-history", "--upstream", "main");
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /No \.up\.sql migrations found under server\/migrations\/ on empty-history/);
});
