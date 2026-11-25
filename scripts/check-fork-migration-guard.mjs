#!/usr/bin/env node
// Fork-side migration number guard (happylwp/multica).
//
// Upstream CI protects multica-ai/multica only: check-migration-numbers.mjs
// runs on upstream PRs and TestMigrationNumericPrefixesAreUnique runs on
// upstream's main, and neither ever sees this fork's refs. This fork keeps
// private migrations in the 900 range (the asset_profile series, currently
// 900-904) while upstream marches upward; when upstream's sequence reaches
// 900 the numbers collide with no textual git conflict, and a naive sync
// turns the fork's migration set ambiguous. Run this as part of every
// upstream-sync routine, right after fetching both remotes.
//
// Two checks:
//  1. Collision: on a fork ref (default fork/main), migration numbers >= 129
//     must map to exactly one stem (an up/down pair counts once, keyed by the
//     file name stem — the same rule and the same 129 cutoff as
//     TestMigrationNumericPrefixesAreUnique and check-migration-numbers.mjs;
//     numbers <= 128 carry historical upstream duplicates and are exempt).
//     Any duplicate fails the run and lists the number with every stem.
//  2. Headroom: distance from upstream's (origin/main) current max number to
//     the fork's reserved 900 range. Below a threshold (default 20, tunable)
//     it warns — without failing — and proposes a full renumber map for the
//     asset_profile series, discovered by stem prefix so it keeps working
//     after the series is itself renumbered. A warning stays exit 0: the fix
//     on the fork side is a planned renumber before the next sync, not an
//     emergency failure; once such a sync lands, check 1 catches the actual
//     duplicate. An exact collision signal ("overlap") is separate from the
//     approximate margin: upstream numbering has skipped numbers before, so
//     a max past the floor only proves a collision when one of upstream's
//     actual numbers lands inside the reserved range.
//
// There is no embed registry to reconcile: migrations.Files() resolves the
// on-disk server/migrations directory directly, so the files on a ref are
// the registration surface this script already covers.
//
// Usage:
//   git fetch origin main && git fetch fork main
//   node scripts/check-fork-migration-guard.mjs \
//     [--ref fork/main] [--upstream origin/main] [--margin 20] [--json]
//
// Exit codes: 0 no collision (a headroom warning is still 0), 1 collision,
// 2 the check could not run.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MIGRATIONS_DIR = "server/migrations";
// Mirrors firstUniqueMigrationNumber in migrations_lint_test.go and
// FIRST_UNIQUE_MIGRATION_NUMBER in check-migration-numbers.mjs: earlier
// numbers carry historical duplicates.
const FIRST_UNIQUE_MIGRATION_NUMBER = 129;
// The fork's private series this guard exists to protect. Matched on the
// stem's name segment so the discovery survives the series being renumbered.
const RESERVED_SERIES_PATTERN = /^\d+_asset_profile(?=_|$)/;
const DEFAULT_MARGIN_THRESHOLD = 20;

export function migrationNumber(stem) {
  const match = /^(\d+)_/.exec(stem);
  return match ? Number(match[1]) : null;
}

// stems: migration file names without the .up.sql suffix, as present on one
// ref. Returns every number >= FIRST_UNIQUE_MIGRATION_NUMBER that more than
// one stem uses, oldest number first, stems sorted within each entry. A stem
// is the version key, so a repeated stem counts once.
export function findDuplicateNumbers(stems) {
  const stemsByNumber = new Map();
  for (const stem of new Set(stems)) {
    const number = migrationNumber(stem);
    if (number === null) continue;
    stemsByNumber.set(number, [...(stemsByNumber.get(number) ?? []), stem]);
  }
  return [...stemsByNumber]
    .filter(([number, owners]) => number >= FIRST_UNIQUE_MIGRATION_NUMBER && owners.length > 1)
    .sort((a, b) => a[0] - b[0])
    .map(([number, owners]) => ({ number, stems: owners.sort() }));
}

// Headroom between upstream's sequence and the fork's reserved series. The
// reserved series is matched by stem prefix plus two guards: its number must
// be >= FIRST_UNIQUE_MIGRATION_NUMBER (below that the number is upstream
// history the fork inherited), and a stem present on the upstream ref too is
// upstream's own migration — renaming it would conflict on every later sync.
// The renumber map targets a contiguous block starting one past whichever
// side is currently higher, so the proposed numbers are free on both sides.
export function assessHeadroom({ upstreamStems, forkStems, threshold = DEFAULT_MARGIN_THRESHOLD }) {
  const upstreamStemSet = new Set(upstreamStems);
  const upstreamNumbers = [...new Set(upstreamStems.map((stem) => migrationNumber(stem)).filter((number) => number !== null))];
  const upstreamMax = upstreamNumbers.length > 0 ? Math.max(...upstreamNumbers) : null;
  const reservedStems = forkStems
    .filter((stem) => RESERVED_SERIES_PATTERN.test(stem))
    .filter((stem) => (migrationNumber(stem) ?? 0) >= FIRST_UNIQUE_MIGRATION_NUMBER)
    .filter((stem) => !upstreamStemSet.has(stem))
    .sort();
  if (reservedStems.length === 0 || upstreamMax === null) {
    return { applicable: false, threshold };
  }
  const reservedNumbers = reservedStems.map((stem) => migrationNumber(stem));
  const reservedFloor = Math.min(...reservedNumbers);
  const reservedCeil = Math.max(...reservedNumbers);
  const forkMax = Math.max(0, ...forkStems.map((stem) => migrationNumber(stem) ?? 0));
  const margin = reservedFloor - upstreamMax;
  // Exact collision signal: upstream numbers that already sit inside the
  // reserved range. A negative margin alone does not prove one, because
  // upstream numbering can skip past the whole range.
  const overlap = upstreamNumbers.filter((number) => number >= reservedFloor && number <= reservedCeil).sort((a, b) => a - b);
  const firstFree = Math.max(forkMax, upstreamMax) + 1;
  const renumberMap = reservedNumbers.map((number, i) => ({
    from: number,
    to: firstFree + i,
    stem: reservedStems[i],
  }));
  return {
    applicable: true,
    threshold,
    upstreamMax,
    reservedFloor,
    reservedCeil,
    margin,
    overlap,
    warn: overlap.length > 0 || margin < threshold,
    renumberMap,
  };
}

export function checkRefs({ ref, upstream, cwd }) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const stemsAt = (revision) =>
    git("ls-tree", "--name-only", revision, "--", `${MIGRATIONS_DIR}/`)
      .split("\n")
      .filter((path) => path.endsWith(".up.sql"))
      .map((path) => path.slice(MIGRATIONS_DIR.length + 1, -".up.sql".length));
  return { forkStems: stemsAt(ref), upstreamStems: stemsAt(upstream) };
}

function describeHeadroom(headroom, upstreamLabel) {
  if (!headroom.applicable) {
    return `No reserved-series migrations found; headroom check skipped (upstream max on ${upstreamLabel} is ${headroom.upstreamMax ?? "unknown"}).`;
  }
  const lines = [];
  const headline = headroom.overlap.length > 0
    ? `Upstream has migration number(s) ${headroom.overlap.join(", ")} inside the fork's reserved range ${headroom.reservedFloor}-${headroom.reservedCeil}; the next upstream sync WILL collide — renumber before syncing.`
    : `Upstream migration max on ${upstreamLabel} is ${headroom.upstreamMax}; headroom to the reserved floor ${headroom.reservedFloor} is ${headroom.margin} (threshold ${headroom.threshold}).`;
  lines.push(headline);
  lines.push(`Renumber the reserved series as follows before the next upstream sync:`);
  for (const { stem, from, to } of headroom.renumberMap) lines.push(`  ${stem}: ${from} -> ${to}`);
  return lines.join("\n");
}

function readFlag(argv, name) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
}

function main(argv) {
  const ref = readFlag(argv, "--ref") ?? "fork/main";
  const upstream = readFlag(argv, "--upstream") ?? "origin/main";
  const threshold = Number(readFlag(argv, "--margin") ?? DEFAULT_MARGIN_THRESHOLD);
  const json = argv.includes("--json");

  let forkStems;
  let upstreamStems;
  try {
    ({ forkStems, upstreamStems } = checkRefs({ ref, upstream }));
  } catch (error) {
    console.error(`Could not read migrations on ${ref} vs ${upstream}: ${error.stderr?.trim() || error.message}`);
    console.error("Fetch both remotes first: git fetch origin main && git fetch fork main");
    return 2;
  }
  if (!Number.isFinite(threshold) || threshold < 0) {
    console.error(`Invalid --margin threshold: ${threshold}`);
    return 2;
  }
  // A resolvable ref with no migrations means the check cannot say anything
  // useful — the guard must not go quietly green (migrationFilesForLint in
  // migrations_lint_test.go fails the same way on an empty directory).
  if (forkStems.length === 0) {
    console.error(`No .up.sql migrations found under ${MIGRATIONS_DIR}/ on ${ref} — wrong ref, or the directory moved?`);
    return 2;
  }
  if (upstreamStems.length === 0) {
    console.error(`No .up.sql migrations found under ${MIGRATIONS_DIR}/ on ${upstream} — wrong ref, or the directory moved?`);
    return 2;
  }

  const duplicates = findDuplicateNumbers(forkStems);
  const headroom = assessHeadroom({ upstreamStems, forkStems, threshold });

  if (json) {
    console.log(JSON.stringify({ ref, upstream, duplicates, headroom }));
  } else {
    const max = Math.max(0, ...forkStems.map((stem) => migrationNumber(stem) ?? 0));
    if (duplicates.length === 0) {
      console.log(`Migration numbers >= ${FIRST_UNIQUE_MIGRATION_NUMBER} are unique on ${ref} (${forkStems.length} migrations, max ${max}).`);
    } else {
      for (const { number, stems } of duplicates) {
        const message = `Migration number ${number} is used by ${stems.length} migrations on ${ref}: ${stems.join(", ")}`;
        console.log(process.env.GITHUB_ACTIONS ? `::error file=${MIGRATIONS_DIR}/${stems[0]}.up.sql::${message}` : `  ${message}`);
      }
      console.error(
        [
          "",
          `${duplicates.length} migration number(s) collide on ${ref}.`,
          "Rename both the .up.sql and .down.sql files (and any references to the",
          "version, such as concurrent index cleanups in server/cmd/migrate/main.go).",
        ].join("\n"),
      );
    }
  }
  if (headroom.warn && !json) {
    const text = describeHeadroom(headroom, upstream);
    console.error(process.env.GITHUB_ACTIONS ? `::warning::${text.replace(/\n\s*/g, " ")}` : text);
  }

  return duplicates.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
