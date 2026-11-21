const path = require("path");
const functions = require("firebase-functions/v1");
const { logger } = require("firebase-functions");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const os = require("os");
const { Storage } = require("@google-cloud/storage");
const gcs = new Storage();

const sharp = require("sharp");
const fs = require("fs-extra");
const uuid = require("uuid");

admin.initializeApp({
  databaseURL: "https://ktp-site-default-rtdb.firebaseio.com/",
});
const getDatabase = () => admin.database();
const usersRef = () => getDatabase().ref("users");
const allowedRef = () => getDatabase().ref("allowed_users");
const publicRef = () => getDatabase().ref("public_users");

const LEETCODE_GRAPHQL_URL = "https://leetcode.com/graphql";
const LEETCODE_STATS_QUERY = `
  query userPublicProfile($username: String!) {
    matchedUser(username: $username) {
      submitStatsGlobal {
        acSubmissionNum {
          difficulty
          count
        }
        totalSubmissionNum {
          difficulty
          count
        }
      }
    }
  }
`;
const LEETCODE_UPDATE_MIN_INTERVAL_MS = 10 * 60 * 1000;
const leetcodeUpdateMetaRef = () =>
  getDatabase().ref("system/leetcode_update_meta");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function countByDifficulty(rows, difficulty) {
  if (!Array.isArray(rows)) return 0;
  const match = rows.find((row) => row && row.difficulty === difficulty);
  return Number(match && match.count) || 0;
}

function sanitizeLeetCodeUsername(raw) {
  if (typeof raw !== "string") return "";
  let username = raw.trim().replace(/^@+/, "");
  if (!username) return "";

  const fromSite = username.match(/leetcode\.com\/(?:u\/)?([^/?#]+)/i);
  if (fromSite && fromSite[1]) return fromSite[1].trim();

  const fromPath = username.match(/^u\/([^/?#]+)/i);
  if (fromPath && fromPath[1]) return fromPath[1].trim();

  username = username.split(/[?#]/)[0] || "";
  if (username.includes("/")) {
    const parts = username.split("/").filter(Boolean);
    username = parts[parts.length - 1] || "";
  }
  return username.replace(/\/+$/, "").trim();
}

function normalizeLeetCodeStats(matchedUser) {
  const stats = matchedUser && matchedUser.submitStatsGlobal;
  if (!stats) return null;

  const easySolved = countByDifficulty(stats.acSubmissionNum, "Easy");
  const mediumSolved = countByDifficulty(stats.acSubmissionNum, "Medium");
  const hardSolved = countByDifficulty(stats.acSubmissionNum, "Hard");
  const totalAccepted = countByDifficulty(stats.acSubmissionNum, "All");
  const totalSubmitted = countByDifficulty(stats.totalSubmissionNum, "All");
  const acceptanceRate =
    totalSubmitted > 0
      ? Math.round((totalAccepted / totalSubmitted) * 10000) / 100
      : 0;

  return {
    easySolved,
    mediumSolved,
    hardSolved,
    acceptanceRate,
  };
}

function formatDurationMs(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  const totalSeconds = Math.ceil(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return minutes + "m " + seconds + "s";
  }

  return seconds + "s";
}

async function claimLeetCodeUpdateSlot(minIntervalMs) {
  const now = Date.now();
  const txResult = await leetcodeUpdateMetaRef()
    .child("lastRunStartedAt")
    .transaction((currentValue) => {
      if (
        typeof currentValue === "number" &&
        now - currentValue < minIntervalMs
      ) {
        return;
      }

      return now;
    });

  if (!txResult.committed) {
    const lastRunStartedAt =
      typeof txResult.snapshot.val() === "number"
        ? txResult.snapshot.val()
        : null;
    const remainingMs = lastRunStartedAt
      ? Math.max(0, minIntervalMs - (now - lastRunStartedAt))
      : minIntervalMs;

    return {
      claimed: false,
      lastRunStartedAt,
      remainingMs,
    };
  }

  return {
    claimed: true,
    lastRunStartedAt: now,
    remainingMs: 0,
  };
}

async function runLeetCodeUpdateWithThrottle(options = {}) {
  const { clearOffsets = false, source = "unknown" } = options;

  const slotResult = await claimLeetCodeUpdateSlot(
    LEETCODE_UPDATE_MIN_INTERVAL_MS
  );

  if (!slotResult.claimed) {
    return {
      throttled: true,
      remainingMs: slotResult.remainingMs,
      lastRunStartedAt: slotResult.lastRunStartedAt,
      summary: null,
    };
  }

  await leetcodeUpdateMetaRef().update({
    lastSource: source,
    lastStatus: "running",
    lastError: null,
  });

  try {
    const summary = await runLeetCodeUpdate({ clearOffsets });

    await leetcodeUpdateMetaRef().update({
      lastStatus: "success",
      lastRunFinishedAt: Date.now(),
      lastSummary: {
        updated: summary.updated,
        failed: summary.failed.length,
        skipped: summary.skipped,
      },
    });

    return {
      throttled: false,
      remainingMs: 0,
      lastRunStartedAt: slotResult.lastRunStartedAt,
      summary,
    };
  } catch (error) {
    await leetcodeUpdateMetaRef().update({
      lastStatus: "error",
      lastRunFinishedAt: Date.now(),
      lastError: error && error.message ? error.message : String(error),
    });
    throw error;
  }
}

async function fetchLeetCodeStats(rawUsername) {
  const username = sanitizeLeetCodeUsername(rawUsername);
  if (!username) {
    return { ok: false, error: "Empty username" };
  }

  let retries = 3;
  let lastError = null;

  while (retries > 0) {
    try {
      const response = await fetch(LEETCODE_GRAPHQL_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Referer: "https://leetcode.com",
          "User-Agent": "ktp-site-leetcode-updater",
        },
        body: JSON.stringify({
          query: LEETCODE_STATS_QUERY,
          variables: { username },
        }),
      });

      if (response && response.ok) {
        const payload = await response.json();
        if (payload.errors && payload.errors.length) {
          lastError =
            payload.errors[0].message || "LeetCode GraphQL returned errors";
          // Missing users will not succeed on retry.
          if (/does not exist/i.test(lastError)) {
            return { ok: false, error: lastError };
          }
        } else {
          const data = normalizeLeetCodeStats(
            payload.data && payload.data.matchedUser
          );
          if (!data) {
            lastError = "User not found or invalid payload";
          } else {
            return { ok: true, data };
          }
        }
      } else {
        lastError = "HTTP " + (response ? response.status : "unknown error");
      }
    } catch (error) {
      lastError = error.message;
    }

    retries--;
    if (retries > 0) {
      await delay(2000);
    }
  }

  return { ok: false, error: lastError };
}

async function runLeetCodeUpdate(options = {}) {
  const { clearOffsets = false } = options;
  const pubusersSnapshot = await publicRef().once("value");
  const pubusers = pubusersSnapshot.val();

  if (!pubusers) {
    return { updated: 0, failed: [], skipped: 0 };
  }

  const failedUsers = [];
  let skipped = 0;
  let updated = 0;

  // Same Firebase write shape as before, but fetch sequentially so LeetCode
  // GraphQL is less likely to rate-limit the scheduled updater.
  for (const user_uid of Object.keys(pubusers)) {
    const user = pubusers[user_uid];

    if (user.leetcode && user.leetcode.username) {
      const username = sanitizeLeetCodeUsername(user.leetcode.username);
      if (!username) {
        skipped++;
        continue;
      }
      logger.log("Updating leetcode stats for " + username);

      const result = await fetchLeetCodeStats(username);
      if (!result.ok) {
        logger.error(
          "Failed to fetch leetcode stats for " + username + ": " + result.error
        );
        failedUsers.push(username);
        await delay(250);
        continue;
      }

      const res = result.data;
      const easySolved = Number(res.easySolved) || 0;
      const mediumSolved = Number(res.mediumSolved) || 0;
      const hardSolved = Number(res.hardSolved) || 0;
      const weightedScore = easySolved * 2 + mediumSolved * 5 + hardSolved * 8;

      await publicRef().child(user_uid + "/leetcode/answers").set({
        easySolved,
        mediumSolved,
        hardSolved,
        totalSolved: easySolved + mediumSolved + hardSolved,
        weightedScore,
        acceptanceRate: Number(res.acceptanceRate) || 0,
        lastUpdated: admin.database.ServerValue.TIMESTAMP,
      });

      if (clearOffsets) {
        await publicRef().child(user_uid + "/leetcode/offsets").set({
          easySolved: 0,
          mediumSolved: 0,
          hardSolved: 0,
        });
      }

      logger.log(
        "Updated " +
          username +
          ": easy=" +
          easySolved +
          ", medium=" +
          mediumSolved +
          ", hard=" +
          hardSolved
      );
      updated++;
      await delay(250);
      continue;
    }

    if (user.leetcode && !user.leetcode.username) {
      logger.log("Removing " + user_uid + "'s leetcode data (no username)");
      await usersRef().child(user_uid + "/leetcode").remove();
      await publicRef().child(user_uid + "/leetcode").remove();
      continue;
    }

    skipped++;
  }

  return {
    updated,
    failed: failedUsers,
    skipped,
  };
}

function emailGradYear(email) {
  if (typeof email !== "string") return null;
  const match = email.trim().toLowerCase().match(/(20\d{2})@(?:u\.)?northwestern\.edu$/);
  return match ? Number(match[1]) : null;
}

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

function roleOf(profile) {
  const role = typeof profile?.role === "object" ? profile.role?.role : profile?.role;
  return typeof role === "string" ? role.trim() : "";
}

async function syncClassYearsFromEmail(asOf = new Date()) {
  const [publicSnap, usersSnap] = await Promise.all([
    publicRef().once("value"),
    usersRef().once("value"),
  ]);
  const publicUsers = publicSnap.val() || {};
  const privateUsers = usersSnap.val() || {};
  const updates = {};
  let updated = 0;
  let skippedManual = 0;
  let skippedNoEmail = 0;
  let unchanged = 0;

  for (const [uid, profile] of Object.entries(publicUsers)) {
    if (!profile || typeof profile !== "object") continue;
    const name = typeof profile.name === "string" ? profile.name.trim() : "";
    if (!name || profile.allowed === false) continue;
    if (profile.class_year_manual === true || privateUsers[uid]?.class_year_manual === true) {
      skippedManual += 1;
      continue;
    }

    const email =
      [profile.email, privateUsers[uid]?.email].find(
        (value) => typeof value === "string" && value.trim()
      ) || "";
    const gradFromEmail = emailGradYear(email);
    if (!gradFromEmail) {
      skippedNoEmail += 1;
      continue;
    }

    const derived = deriveFromGradYear(gradFromEmail, asOf);
    const alumni =
      roleOf(profile).toLowerCase() === "alumni" || derived.standing === "Alumni";
    const currentYear = String(privateUsers[uid]?.year || profile.year || "").trim();
    const currentGrad = String(
      privateUsers[uid]?.graduation_year || profile.graduation_year || ""
    ).trim();
    const next = {};

    if (alumni) {
      if (currentGrad !== derived.graduation_year) next.graduation_year = derived.graduation_year;
      if (currentYear !== "Alumni") next.year = "Alumni";
    } else if (currentYear !== derived.standing) {
      next.year = derived.standing;
    }

    if (!Object.keys(next).length) {
      unchanged += 1;
      continue;
    }

    next.class_year_manual = false;
    updated += 1;
    for (const [field, value] of Object.entries(next)) {
      updates[`public_users/${uid}/${field}`] = value;
      updates[`users/${uid}/${field}`] = value;
    }
  }

  if (Object.keys(updates).length) {
    await getDatabase().ref().update(updates);
  }

  return { updated, skippedManual, skippedNoEmail, unchanged };
}

// Once a year on Sept 1 at midnight Chicago — bump standings from NU email class years.
exports.syncClassFromEmail = onSchedule(
  {
    schedule: "0 0 1 9 *",
    timeZone: "America/Chicago",
  },
  async () => {
    logger.log("Scheduled class-year sync starting...");
    try {
      const summary = await syncClassYearsFromEmail(new Date());
      logger.log("Scheduled class-year sync completed", summary);
    } catch (error) {
      logger.error("Scheduled class-year sync failed:", error);
      throw error;
    }
  }
);

// Admin-only manual refresh (same logic as Sept 1 job).
exports.syncClassFromEmailNow = functions.https.onCall(async (data, context) => {
  if (!context.auth) throw new Error("User not authenticated");
  const userSnapshot = await usersRef().child(context.auth.uid).once("value");
  if (!userSnapshot.val() || !userSnapshot.val().admin) {
    throw new Error("User is not an admin");
  }
  const summary = await syncClassYearsFromEmail(new Date());
  logger.log("Manual class-year sync completed", summary);
  return { status: "ok", ...summary };
});

// Once daily at midnight Chicago time. Admin lcupdateNow can still refresh manually.
exports.lcupdate = onSchedule(
  {
    schedule: "0 0 * * *",
    timeZone: "America/Chicago",
  },
  async (event) => {
  logger.log("LeetCode update function starting...");
  
  try {
    const runResult = await runLeetCodeUpdateWithThrottle({
      clearOffsets: false,
      source: "scheduled",
    });

    if (runResult.throttled) {
      logger.log(
        "LeetCode update skipped due to throttle. Retry in " +
          formatDurationMs(runResult.remainingMs) +
          "."
      );
      return;
    }

    const summary = runResult.summary;
    logger.log(
      "LeetCode update completed. updated=" +
        summary.updated +
        ", failed=" +
        summary.failed.length +
        ", skipped=" +
        summary.skipped
    );
  } catch (error) {
    logger.error("LeetCode update function error:", error);
    throw error;
  }
});

// Manual function to trigger LC update (for testing)
exports.lcupdateNow = functions.https.onCall(async (data, context) => {
  logger.log("Manual LeetCode update triggered");
  
  try {
    // Check if user is admin
    if (!context.auth) {
      throw new Error("User not authenticated");
    }
    
    const userSnapshot = await usersRef().child(context.auth.uid).once("value");
    if (!userSnapshot.val() || !userSnapshot.val().admin) {
      throw new Error("User is not an admin");
    }
    
    const initialScrape = !!(data && data.initialScrape);
    const runResult = await runLeetCodeUpdateWithThrottle({
      clearOffsets: initialScrape,
      source: "manual-admin",
    });

    if (runResult.throttled) {
      return {
        status: "throttled",
        message:
          "LeetCode API updates are limited to once every 10 minutes. Try again in " +
          formatDurationMs(runResult.remainingMs) +
          ".",
        retryAfterMs: runResult.remainingMs,
      };
    }

    const summary = runResult.summary;
    logger.log("Manual update completed. Updated " + summary.updated + " users");

    return { 
      status: "success", 
      message: initialScrape
        ? "Initial scrape completed for " + summary.updated + " LeetCode profiles"
        : "Updated " + summary.updated + " LeetCode profiles",
      initialScrape,
      updated: summary.updated,
      failed: summary.failed.length > 0 ? summary.failed : null,
      skipped: summary.skipped
    };
  } catch (error) {
    logger.error("Manual LeetCode update error:", error);
    throw new functions.https.HttpsError("internal", error.message);
  }
});

// Admin function to reset a specific user's LeetCode offsets
// This is useful if offsets were set incorrectly and you want the user's actual total count
// Usage: Call with data.username = "leetcode_username" to reset that user's offsets
exports.resetLcOffsets = functions.https.onCall(async (data, context) => {
  try {
    // Check if user is admin
    if (!context.auth) {
      throw new Error("User not authenticated");
    }
    
    const userSnapshot = await usersRef().child(context.auth.uid).once("value");
    if (!userSnapshot.val() || !userSnapshot.val().admin) {
      throw new Error("User is not an admin");
    }
    
    const targetUsername = data.username;
    if (!targetUsername) {
      throw new Error("Target username not provided");
    }
    
    logger.log("Admin attempting to reset offsets for: " + targetUsername);
    
    // Find the user with this username
    const pubusersSnapshot = await publicRef().once("value");
    const pubusers = pubusersSnapshot.val();
    
    let targetUid = null;
    for (const uid in pubusers) {
      if (pubusers[uid].leetcode && pubusers[uid].leetcode.username === targetUsername) {
        targetUid = uid;
        break;
      }
    }
    
    if (!targetUid) {
      throw new Error("User with username " + targetUsername + " not found");
    }
    
    const targetUser = pubusers[targetUid];
    
    if (!targetUser.leetcode || !targetUser.leetcode.answers) {
      throw new Error("Target user has no leetcode answers to reset");
    }
    
    // Reset offsets to match current answers
    const newOffsets = {
      easySolved: targetUser.leetcode.answers.easySolved,
      mediumSolved: targetUser.leetcode.answers.mediumSolved,
      hardSolved: targetUser.leetcode.answers.hardSolved,
    };
    
    await publicRef().child(targetUid + "/leetcode/offsets").set(newOffsets);
    
    logger.log("Successfully reset offsets for " + targetUsername + ". New offsets: " + JSON.stringify(newOffsets));
    
    return {
      status: "success",
      message: "Offsets reset for " + targetUsername,
      username: targetUsername,
      oldScore: "Recalculated to 0",
      explanation: "User's current answers are now treated as their starting point"
    };
  } catch (error) {
    logger.error("Reset offsets error:", error);
    throw new functions.https.HttpsError("internal", error.message);
  }
});

exports.setUserAdmin = functions.https.onCall(async (data, context) => {
  try {
    if (!context.auth) {
      throw new functions.https.HttpsError(
        "unauthenticated",
        "User not authenticated"
      );
    }

    const callerSnapshot = await usersRef().child(context.auth.uid).once("value");
    if (!callerSnapshot.exists() || callerSnapshot.val().admin !== true) {
      throw new functions.https.HttpsError(
        "permission-denied",
        "Only admins can update admin access"
      );
    }

    const targetUid =
      data && typeof data.targetUid === "string" ? data.targetUid.trim() : "";
    const nextAdmin = data && typeof data.admin === "boolean" ? data.admin : null;

    if (!targetUid) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "targetUid is required"
      );
    }

    if (nextAdmin === null) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "admin must be a boolean"
      );
    }

    if (targetUid === context.auth.uid && nextAdmin === false) {
      throw new functions.https.HttpsError(
        "failed-precondition",
        "You cannot remove your own admin access"
      );
    }

    const targetSnapshot = await usersRef().child(targetUid).once("value");
    if (!targetSnapshot.exists()) {
      throw new functions.https.HttpsError("not-found", "Target user not found");
    }

    await usersRef().child(targetUid).update({ admin: nextAdmin });

    logger.log(
      "Admin access updated by " +
        context.auth.uid +
        " for " +
        targetUid +
        " -> " +
        String(nextAdmin)
    );

    return {
      status: "success",
      targetUid,
      admin: nextAdmin,
    };
  } catch (error) {
    logger.error("setUserAdmin error:", error);
    if (error instanceof functions.https.HttpsError) {
      throw error;
    }
    throw new functions.https.HttpsError(
      "internal",
      error && error.message ? error.message : "Unknown error"
    );
  }
});

exports.resizeCover = functions.storage.object().onFinalize(async (object) => {
  try {
    // generate a unique name we'll use for the temp directories
    const uniqueName = uuid.v1();

    // Get the bucket original image was uploaded to
    const bucket = gcs.bucket(object.bucket);

    // Set up bucket directory
    var filePath = object.name;
    if (filePath.includes("resume")) {
      return false;
    }
    const uid = filePath.split("/").pop().split(".")[0];
    const fileName = uid + ".jpg";
    const bucketDir = path.dirname(filePath);

    // create some temp working directories to process images
    const workingDir = path.join(os.tmpdir(), `images_${uniqueName}`);
    const tmpFilePath = path.join(workingDir, `source_${uniqueName}.png`);
    const metadata = object.metadata;

    if (metadata.isThumb) {
      console.log("Exiting image resizer!");
      return false;
    }

    // Ensure directory exists
    await fs.ensureDir(workingDir);

    // Download source file
    await bucket.file(filePath).download({
      destination: tmpFilePath,
    });
    // Resize images
    var sizes;
    if (filePath.includes("pfp")) {
      sizes = [128, 256];
    } else {
      sizes = [1400];
    }
    const uploadPromises = sizes.map(async (size) => {
      const thumbName = `${size}_${fileName}`;
      const thumbPath = path.join(workingDir, thumbName);

      if (size < 300) {
        // Square aspect ratio
        // Good for profile images
        await sharp(tmpFilePath)
          .resize(size, size)
          .withMetadata()
          .toFile(thumbPath);
      } else {
        // 16:9 aspect ratio
        let height = Math.floor(size * 0.5625);

        await sharp(tmpFilePath)
          .resize(size, height)
          .withMetadata()
          .toFile(thumbPath);
      }
      metadata.isThumb = true;

      // upload to original bucket
      return await bucket
        .upload(thumbPath, {
          destination: path.join(bucketDir, thumbName),
          metadata: { metadata: metadata },
          predefinedAcl: "publicRead",
          public: true,
        })
        .then((result) => {
          const file = result[0];
          return file.getMetadata();
        })
        .then(async (data) => {
          const metadata = data[0];
          //todo: delete original image
          if (size === 128) {
            await usersRef().child(uid).update({
              pfp_thumb_link: metadata.mediaLink,
            });
            await publicRef().child(uid).update({
              pfp_thumb_link: metadata.mediaLink,
            });
          } else if (size === 256) {
            await usersRef().child(uid).update({
              pfp_large_link: metadata.mediaLink,
            });
            await publicRef().child(uid).update({
              pfp_large_link: metadata.mediaLink,
            });
          } else if (size === 1400) {
            await usersRef().child(uid).update({
              cover_resized_link: metadata.mediaLink,
            });
            await publicRef().child(uid).update({
              cover_resized_link: metadata.mediaLink,
            });
          }
        });
    });

    // Process promises outside of the loop for performance purposes
    await Promise.all(uploadPromises);

    // Remove the temp directories
    await fs.remove(workingDir);
    await fs.remove(bucketDir);

    return Promise.resolve();
  } catch (error) {
    // If we have an error, return it
    // This will allow us to view it in the firebase function logs
    return Promise.reject(error);
  }
});

exports.beforeSignIn = functions.auth.user().beforeSignIn(async (user) => {
  if (user.email.includes("northwestern.edu")) {
    allowedRef()
      .child(user.email.substring(0, user.email.indexOf("@")))
      .once("value", (snapshot) => {
        if (snapshot.exists()) {
          usersRef().child(user.uid).update({ allowed: true });
          admin.auth().setCustomUserClaims(user.uid, {
            member: true,
          });
        }
      });
  }
});

exports.beforeAcc = functions.auth.user().beforeCreate(async (user) => {
  if (!user.email.includes("northwestern.edu")) {
    await usersRef().child(user.uid).set({
      allowed: false,
      signed_up: false,
    });
  }
  const prom = new Promise((resolve, reject) => {
    allowedRef()
      .child(user.email.substring(0, user.email.indexOf("@")))
      .once("value", async (allowed_snapshot) => {
        if (allowed_snapshot.exists()) {
          usersRef().child(user.uid).once("value", async (user_snapshot) => {
            if (!user_snapshot.exists()) {
              functions.logger.log("Adding user " + user.email);
              var newuser_role = "Member";
              if (allowed_snapshot.val() != "") {
                newuser_role = allowed_snapshot.val();
              }
              await usersRef().child(user.uid).set({
                allowed: true,
                signed_up: false,
                role: newuser_role,
                profile_pic_link: user.photoURL,
                // Empty covers use the portal's shared purple ninja banner.
                cover_page_link: "",
                email: user.email,
              });
              await publicRef().child(user.uid).set({
                profile_pic_link: user.photoURL,
                role: newuser_role,
                cover_page_link: "",
              });
              resolve(1); //allowed but needs to sign up, correct
            } else if (user_snapshot.val()["signed_up"]) {
              functions.logger.log("Already signed up:" + user.email);
              resolve(2);
              //already has uid record and signed up
            } else if (!user_snapshot.val()["signed_up"]) {
              functions.logger.log("Needs to sign up:" + user.email);
              //needs to sign up
              resolve(1);
            } else {
              functions.logger.log("Shouldn't be possible:" + user.email);
              //already has uid record but not signed up - shouldnt be possible
              resolve(3);
            }
            admin.auth().setCustomUserClaims(user.uid, {
              member: true,
            });
          });
        } else {
          functions.logger.log("Rejected account creation by " + user.email);
          reject(4);
        }
      });
  });
  try {
    const res = await prom;
    console.log("Promise result: " + res);
    return true;
  } catch (err) {
    throw new functions.auth.HttpsError("permission-denied");
  }
});
