// CRA only enables Tailwind when tailwind.config.js exists at the project root.
// Keep this thin re-export so any tooling under config/ still resolves.
module.exports = require("../tailwind.config.js");
