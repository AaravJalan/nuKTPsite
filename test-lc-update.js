const admin = require('firebase-admin');

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  databaseURL: "https://ktp-site-default-rtdb.firebaseio.com/",
});

const db = admin.database();

const LEETCODE_GRAPHQL_URL = "https://leetcode.com/graphql";
const LEETCODE_STATS_QUERY = `
  query userPublicProfile($username: String!) {
    matchedUser(username: $username) {
      submitStatsGlobal {
        acSubmissionNum { difficulty count }
        totalSubmissionNum { difficulty count }
      }
    }
  }
`;

function countByDifficulty(rows, difficulty) {
  if (!Array.isArray(rows)) return 0;
  const match = rows.find((row) => row && row.difficulty === difficulty);
  return Number(match && match.count) || 0;
}

async function fetchLeetCodeStats(username) {
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

  if (!response.ok) {
    throw new Error("HTTP " + response.status);
  }

  const payload = await response.json();
  const stats = payload.data && payload.data.matchedUser && payload.data.matchedUser.submitStatsGlobal;
  if (!stats) {
    throw new Error("User not found or invalid payload");
  }

  const easySolved = countByDifficulty(stats.acSubmissionNum, "Easy");
  const mediumSolved = countByDifficulty(stats.acSubmissionNum, "Medium");
  const hardSolved = countByDifficulty(stats.acSubmissionNum, "Hard");
  const totalAccepted = countByDifficulty(stats.acSubmissionNum, "All");
  const totalSubmitted = countByDifficulty(stats.totalSubmissionNum, "All");
  const acceptanceRate =
    totalSubmitted > 0
      ? Math.round((totalAccepted / totalSubmitted) * 10000) / 100
      : 0;

  return { easySolved, mediumSolved, hardSolved, acceptanceRate };
}

// Simulate the lcupdateNow function logic
async function triggerLcUpdate() {
  try {
    console.log("Starting LeetCode update...");
    
    const pubusersSnapshot = await db.ref("public_users").once("value");
    const pubusers = pubusersSnapshot.val();
    
    if (!pubusers) {
      console.log("No public users found");
      return { status: "No users found", updated: 0 };
    }
    
    let updatedCount = 0;
    const updatePromises = [];
    
    for (const user_uid in pubusers) {
      const user = pubusers[user_uid];
      
      if (user.leetcode && user.leetcode.username) {
        console.log("Updating leetcode stats for " + user.leetcode.username);
        
        const updatePromise = (async () => {
          try {
            const res = await fetchLeetCodeStats(user.leetcode.username);
            
            console.log("Fetched stats for " + user.leetcode.username + ":", res);
            
            // Set offsets on first run if they don't exist
            if (!user.leetcode.offsets) {
              await db.ref(user_uid + "/leetcode/offsets").set({
                easySolved: res.easySolved,
                mediumSolved: res.mediumSolved,
                hardSolved: res.hardSolved,
              });
              console.log("Set initial offsets for " + user.leetcode.username);
            }
            
            // Update the current answers
            await db.ref("public_users/" + user_uid + "/leetcode/answers").set({
              easySolved: res.easySolved,
              mediumSolved: res.mediumSolved,
              hardSolved: res.hardSolved,
              acceptanceRate: res.acceptanceRate,
            });
            console.log("Successfully updated leetcode stats for " + user.leetcode.username);
            return true;
          } catch (error) {
            console.error("Error processing leetcode data for " + user_uid + ":", error);
            return false;
          }
        })();
        
        updatePromises.push(updatePromise);
      }
    }
    
    const results = await Promise.all(updatePromises);
    updatedCount = results.filter(r => r === true).length;
    
    console.log("Update completed. Updated " + updatedCount + " users");
    return { 
      status: "success", 
      message: "Updated " + updatedCount + " LeetCode profiles",
      updated: updatedCount 
    };
  } catch (error) {
    console.error("LeetCode update error:", error);
    throw error;
  }
}

triggerLcUpdate().then(() => {
  console.log("✅ LeetCode update completed!");
  process.exit(0);
}).catch(err => {
  console.error("❌ Error:", err);
  process.exit(1);
});
