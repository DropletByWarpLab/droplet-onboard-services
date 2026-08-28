const { createHash } = require("node:crypto");

// WARP-2481 PROOF COMMIT - DO NOT MERGE. Deliberate FIPS violation with no
// registered fips:allowed escape, to demonstrate that ci-summary now goes RED
// because of the fips leg. This branch is deleted as soon as the run is
// captured.
module.exports = (s) => createHash("md5").update(s).digest("hex");
