#!/usr/bin/env node
/**
 * Derive class standing / graduation year from NU emails (...YYYY@u.northwestern.edu).
 *
 * Dry-run by default. Apply with: node scripts/ops/sync-class-from-email.js --apply
 *
 * Skips profiles with class_year_manual=true (set when a member overrides standing in settings).
 *
 * Fall academic year (Aug–Jul): class of (year+1) = Senior, +2 Junior, +3 Sophomore, +4 Freshman.
 * As of Fall 2026 → 2027 Senior, 2028 Junior, 2029 Sophomore, 2030 Freshman; ≤2026 Alumni.
 */

const { spawnSync } = require("child_process");
const path = require("path");

const PROJECT = "ktp-site";
const APPLY = process.argv.includes("--apply");
const ROOT = path.resolve(__dirname, "..");

function emailGradYear(email) {
  if (typeof email !== "string") return null;
  const match = email.trim().toLowerCase().match(/(20\d{2})@(?:u\.)?northwestern\.edu$/);
  return match ? Number(match[1]) : null;
}

function roleOf(profile) {
  const role = typeof profile?.role === "object" ? profile.role?.role : profile?.role;
  return typeof role === "string" ? role.trim() : "";
}

function isAlumniRole(profile) {
  return roleOf(profile).toLowerCase() === "alumni";
}

/** @param {number} gradYear @param {Date} [asOf] */
function deriveFromGradYear(gradYear, asOf = new Date()) {
  const academicStartYear = asOf.getMonth() >= 7 ? asOf.getFullYear() : asOf.getFullYear() - 1;
  const seniorClass = academicStartYear + 1;
  const delta = gradYear - seniorClass;
  if (delta < 0) return { standing: "Alumni", graduation_year: String(gradYear) };
  if (delta === 0) return { standing: "Senior", graduation_year: String(gradYear) };
  if (delta === 1) return { standing: "Junior", graduation_year: String(gradYear) };
  if (delta === 2) return { standing: "Sophomore", graduation_year: String(gradYear) };
  return { standing: "Freshman", graduation_year: String(gradYear) };
}

function firebaseGet(dbPath) {
  const result = spawnSync(
    "firebase",
    ["database:get", dbPath, "--project", PROJECT],
    { encoding: "utf8", cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "firebase database:get failed").trim());
  }
  return JSON.parse(result.stdout || "null");
}

function firebaseUpdate(updates) {
  const result = spawnSync(
    "firebase",
    ["database:update", "/", "--project", PROJECT, "--data", JSON.stringify(updates), "--force"],
    { encoding: "utf8", cwd: ROOT, maxBuffer: 32 * 1024 * 1024 }
  );
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "firebase database:update failed").trim());
  }
}

function planUpdates(publicUsers, privateUsers = {}, asOf = new Date()) {
  const changes = [];
  const skipped = [];

  for (const [uid, profile] of Object.entries(publicUsers || {})) {
    if (!profile || typeof profile !== "object") continue;
    const name = typeof profile.name === "string" ? profile.name.trim() : "";
    if (!name || profile.allowed === false) continue;

    if (profile.class_year_manual === true || privateUsers?.[uid]?.class_year_manual === true) {
      skipped.push({ uid, name, email: profile.email || "", reason: "manual override in settings" });
      continue;
    }

    const email = [profile.email, privateUsers?.[uid]?.email].find((value) => typeof value === "string" && value.trim()) || "";
    const gradFromEmail = emailGradYear(email);
    if (!gradFromEmail) {
      skipped.push({ uid, name, email, reason: "no YYYY in NU email" });
      continue;
    }

    const derived = deriveFromGradYear(gradFromEmail, asOf);
    const alumni = isAlumniRole(profile) || derived.standing === "Alumni";
    const currentYear = String(privateUsers?.[uid]?.year || profile.year || "").trim();
    const currentGrad = String(privateUsers?.[uid]?.graduation_year || profile.graduation_year || "").trim();
    const next = {};

    if (alumni) {
      if (currentGrad !== derived.graduation_year) next.graduation_year = derived.graduation_year;
      if (currentYear !== "Alumni") next.year = "Alumni";
    } else if (currentYear !== derived.standing) {
      next.year = derived.standing;
    }

    if (!Object.keys(next).length) {
      skipped.push({ uid, name, email: profile.email, reason: "already up to date", derived: derived.standing });
      continue;
    }

    next.class_year_manual = false;

    const beforeYear = privateUsers?.[uid]?.year || profile.year || "";
    const beforeGrad = privateUsers?.[uid]?.graduation_year || profile.graduation_year || "";
    changes.push({
      uid,
      name,
      email,
      role: roleOf(profile) || "(none)",
      before: { year: beforeYear, graduation_year: beforeGrad },
      after: { year: beforeYear, graduation_year: beforeGrad, ...next },
      fields: next,
    });
  }

  return { changes, skipped };
}

function toRootUpdates(changes) {
  const updates = {};
  for (const change of changes) {
    for (const [field, value] of Object.entries(change.fields)) {
      updates[`public_users/${change.uid}/${field}`] = value;
      updates[`users/${change.uid}/${field}`] = value;
    }
  }
  return updates;
}

function main() {
  console.log(APPLY ? "APPLY mode — writing to Firebase\n" : "DRY RUN — no writes (pass --apply to write)\n");
  const publicUsers = firebaseGet("/public_users");
  const privateUsers = firebaseGet("/users");
  const { changes, skipped } = planUpdates(publicUsers, privateUsers);
  const noEmail = skipped.filter((s) => s.reason.startsWith("no YYYY"));
  const manual = skipped.filter((s) => s.reason.startsWith("manual"));
  const upToDate = skipped.length - noEmail.length - manual.length;

  console.log(`Would update: ${changes.length}`);
  console.log(`Already current: ${upToDate}`);
  console.log(`Manual overrides skipped: ${manual.length}`);
  console.log(`No class year in email: ${noEmail.length}\n`);

  for (const change of changes.sort((a, b) => a.name.localeCompare(b.name))) {
    const bits = Object.entries(change.fields)
      .map(([field, value]) => `${field}: ${change.before[field] || "∅"} → ${value}`)
      .join(", ");
    console.log(`- ${change.name} [${change.role}] ${change.email}\n  ${bits}`);
  }

  if (noEmail.length) {
    console.log("\nSkipped (no YYYY@…northwestern.edu):");
    for (const row of noEmail.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`- ${row.name} (${row.email || "no email"})`);
    }
  }

  if (!APPLY) {
    console.log("\nRe-run with --apply to write public_users + users.");
    return;
  }

  const updates = toRootUpdates(changes);
  const keys = Object.keys(updates);
  if (!keys.length) {
    console.log("\nNothing to write.");
    return;
  }

  const chunkSize = 200;
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = {};
    for (const key of keys.slice(i, i + chunkSize)) chunk[key] = updates[key];
    console.log(`\nWriting chunk ${i / chunkSize + 1} (${Object.keys(chunk).length} paths)…`);
    firebaseUpdate(chunk);
  }
  console.log("\nDone.");
}

module.exports = { emailGradYear, deriveFromGradYear, planUpdates, toRootUpdates };

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}
