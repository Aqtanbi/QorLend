// Deploys the mock tokens, the mock oracle and QorLendPool to a LOCAL network.
// 1) terminal A: npx hardhat node          (local chain with test accounts, chain id 31337)
// 2) terminal B: npx hardhat run scripts/deploy.js --network localhost
// Test accounts only. Never use this with a real network or real keys.
const { ethers, network } = require("hardhat");

async function main() {
  if (![31337n, 1337n].includes((await ethers.provider.getNetwork()).chainId)) {
    throw new Error("This educational prototype may only be deployed to a local network.");
  }
  const [admin] = await ethers.getSigners();
  const Token = await ethers.getContractFactory("MockToken");
  const collateral = await Token.deploy("Mock Collateral", "mCOL");
  const stable = await Token.deploy("Mock Stable Unit", "mUSD");
  const oracle = await (await ethers.getContractFactory("MockOracle")).deploy(ethers.parseEther("10"));
  const pool = await (await ethers.getContractFactory("QorLendPool")).deploy(
    collateral.target, stable.target, oracle.target, admin.address);
  await pool.waitForDeployment();

  console.log(`Network: ${network.name}`);
  console.log(`mCOL (MockToken):  ${collateral.target}`);
  console.log(`mUSD (MockToken):  ${stable.target}`);
  console.log(`MockOracle:        ${oracle.target}`);
  console.log(`QorLendPool:       ${pool.target}`);
}
main().catch((err) => { console.error(err); process.exit(1); });
