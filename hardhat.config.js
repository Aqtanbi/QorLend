require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
const path = require("path");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");

// Uses the compiler from the "solc" npm package, so no download from an external
// server is needed. Works the same on any computer after "npm install".
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion === "0.8.24") {
    const compilerPath = require.resolve("solc/soljson.js");
    return { compilerPath, isSolcJs: true, version: "0.8.24", longVersion: "0.8.24" };
  }
  return runSuper();
});

/** Local development network only (Hardhat Network). No keys, no real funds. */
module.exports = {
  solidity: { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 } } },
};
