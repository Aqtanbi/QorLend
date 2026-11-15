// Demo of the main use case on the local Hardhat network (test accounts only).
// Run: npx hardhat run scripts/demo.js
const { ethers } = require("hardhat");
const e = (n) => ethers.parseEther(String(n));
const f = (n) => Number(ethers.formatEther(n)).toFixed(2);

async function main() {
  const [admin, borrower, supplier, liquidator] = await ethers.getSigners();
  console.log("Educational project. Local test network only. Not a real product.\n");

  const Token = await ethers.getContractFactory("MockToken");
  const collateral = await Token.deploy("Mock Collateral", "mCOL");
  const stable = await Token.deploy("Mock Stable Unit", "mUSD");
  const oracle = await (await ethers.getContractFactory("MockOracle")).deploy(e(10));
  const pool = await (await ethers.getContractFactory("QorLendPool")).deploy(
    collateral.target, stable.target, oracle.target, admin.address);
  console.log("1. Deployed QorLendPool at", pool.target);

  await stable.mint(supplier.address, e(10000));
  await stable.connect(supplier).approve(pool.target, e(10000));
  await pool.connect(supplier).supplyLiquidity(e(10000));
  console.log("2. Supplier added 10,000 mUSD of liquidity");

  await collateral.mint(borrower.address, e(100));
  await collateral.connect(borrower).approve(pool.target, e(100));
  await pool.connect(borrower).depositCollateral(e(100));
  console.log("3. Borrower deposited 100 mCOL (price 10 mUSD, value 1,000 mUSD)");

  await pool.connect(borrower).borrow(e(550));
  console.log("4. Borrower borrowed 550 mUSD (55% LTV). Health factor:", f(await pool.healthFactor(borrower.address)));

  await oracle.setPrice(e(7));
  console.log("5. Price falls 30% to 7 mUSD. Health factor:", f(await pool.healthFactor(borrower.address)), "(below 1.00 = unsafe)");

  await stable.mint(liquidator.address, e(1000));
  await stable.connect(liquidator).approve(pool.target, e(1000));
  await pool.connect(liquidator).liquidate(borrower.address, e(1000));
  const pos = await pool.positions(borrower.address);
  console.log("6. Liquidator repaid the debt and received", f(await collateral.balanceOf(liquidator.address)), "mCOL (5% bonus)");
  console.log("   Borrower debt now:", f(pos.debt), "| collateral left:", f(pos.collateral), "mCOL");
}
main().catch((err) => { console.error(err); process.exit(1); });
