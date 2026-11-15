// Unit tests for QorLendPool. Local Hardhat network, test accounts only.
// Run: npx hardhat test
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const e = (n) => ethers.parseEther(String(n));
const ONE = e(1);
const TOLERANCE = e("0.01"); // a few seconds of interest between transactions

async function deployFixture() {
  const [admin, borrower, supplier, liquidator, stranger] = await ethers.getSigners();

  const Token = await ethers.getContractFactory("MockToken");
  const collateral = await Token.deploy("Mock Collateral", "mCOL");
  const stable = await Token.deploy("Mock Stable Unit", "mUSD");
  const oracle = await (await ethers.getContractFactory("MockOracle")).deploy(e(10)); // 1 mCOL = 10 mUSD
  const pool = await (await ethers.getContractFactory("QorLendPool")).deploy(
    collateral.target, stable.target, oracle.target, admin.address);

  // supplier adds 10,000 mUSD of liquidity
  await stable.mint(supplier.address, e(10000));
  await stable.connect(supplier).approve(pool.target, e(10000));
  await pool.connect(supplier).supplyLiquidity(e(10000));

  // borrower has 100 mCOL (value 1,000 mUSD) and some mUSD to pay interest
  await collateral.mint(borrower.address, e(100));
  await collateral.connect(borrower).approve(pool.target, ethers.MaxUint256);
  await stable.mint(borrower.address, e(200));
  await stable.connect(borrower).approve(pool.target, ethers.MaxUint256);

  // liquidator has mUSD to repay unsafe loans
  await stable.mint(liquidator.address, e(1000));
  await stable.connect(liquidator).approve(pool.target, ethers.MaxUint256);

  return { pool, collateral, stable, oracle, admin, borrower, supplier, liquidator, stranger };
}

// borrower deposits 100 mCOL and borrows 550 mUSD (55% LTV, health factor 1.36)
async function borrowedFixture() {
  const ctx = await deployFixture();
  await ctx.pool.connect(ctx.borrower).depositCollateral(e(100));
  await ctx.pool.connect(ctx.borrower).borrow(e(550));
  return ctx;
}

describe("QorLendPool", function () {
  it("1. deploys with the Endterm risk parameters and admin roles", async function () {
    const { pool, admin, stranger } = await loadFixture(deployFixture);
    expect(await pool.MAX_LTV_BPS()).to.equal(6000n);
    expect(await pool.LIQ_THRESHOLD_BPS()).to.equal(7500n);
    expect(await pool.BORROW_RATE_BPS()).to.equal(1600n);
    expect(await pool.hasRole(await pool.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
    expect(await pool.hasRole(await pool.PAUSER_ROLE(), admin.address)).to.equal(true);
    expect(await pool.hasRole(await pool.PAUSER_ROLE(), stranger.address)).to.equal(false);
  });

  it("2. lets a borrower deposit collateral and borrow within the max LTV", async function () {
    const { pool, stable, borrower } = await loadFixture(deployFixture);
    await expect(pool.connect(borrower).depositCollateral(e(100)))
      .to.emit(pool, "CollateralDeposited").withArgs(borrower.address, e(100));
    await expect(pool.connect(borrower).borrow(e(550)))
      .to.emit(pool, "Borrowed").withArgs(borrower.address, e(550));

    expect(await stable.balanceOf(borrower.address)).to.equal(e(750)); // 200 own + 550 borrowed
    // health factor = 1,000 x 0.75 / 550 = 1.3636...
    expect(await pool.healthFactor(borrower.address)).to.be.closeTo(e("1.3636"), e("0.0001"));
  });

  it("3. rejects a loan above 60% LTV and zero amounts", async function () {
    const { pool, borrower } = await loadFixture(deployFixture);
    await pool.connect(borrower).depositCollateral(e(100));
    await expect(pool.connect(borrower).borrow(e("600.01"))).to.be.revertedWith("exceeds max LTV");
    await expect(pool.connect(borrower).borrow(0)).to.be.revertedWith("amount is zero");
    await expect(pool.connect(borrower).borrow(e(600))).to.emit(pool, "Borrowed"); // exactly 60% is allowed
  });

  it("4. rejects a loan larger than the available liquidity", async function () {
    const { pool, collateral, borrower } = await loadFixture(deployFixture);
    await collateral.mint(borrower.address, e(10000));
    await pool.connect(borrower).depositCollateral(e(10100)); // value 101,000 mUSD
    await expect(pool.connect(borrower).borrow(e(10001))).to.be.revertedWith("not enough liquidity");
  });

  it("5. accrues 16% simple interest per year", async function () {
    const { pool, borrower } = await loadFixture(borrowedFixture);
    await time.increase(365 * 24 * 60 * 60);
    // 550 x 1.16 = 638 mUSD
    expect(await pool.currentDebt(borrower.address)).to.be.closeTo(e(638), TOLERANCE);
  });

  it("6. lets the borrower repay the full debt and withdraw all collateral", async function () {
    const { pool, collateral, borrower } = await loadFixture(borrowedFixture);
    await time.increase(30 * 24 * 60 * 60);
    await pool.connect(borrower).repay(e(1000)); // overpayment is capped at the debt
    const pos = await pool.positions(borrower.address);
    expect(pos.debt).to.equal(0n);

    await pool.connect(borrower).withdrawCollateral(e(100));
    expect(await collateral.balanceOf(borrower.address)).to.equal(e(100));
  });

  it("7. blocks a collateral withdrawal that would break the max LTV", async function () {
    const { pool, borrower } = await loadFixture(borrowedFixture);
    // 550 debt needs at least 91.67 mCOL at price 10
    await expect(pool.connect(borrower).withdrawCollateral(e(10))).to.be.revertedWith("would exceed max LTV");
    await expect(pool.connect(borrower).withdrawCollateral(e(8))).to.emit(pool, "CollateralWithdrawn");
  });

  it("8. liquidates an unsafe position with a 5% bonus after the price falls", async function () {
    const { pool, oracle, collateral, borrower, liquidator } = await loadFixture(borrowedFixture);
    await expect(pool.connect(liquidator).liquidate(borrower.address, e(550)))
      .to.be.revertedWith("position is healthy");

    await oracle.setPrice(e(7)); // price falls 30%
    expect(await pool.healthFactor(borrower.address)).to.be.lessThan(ONE);

    await expect(pool.connect(liquidator).liquidate(borrower.address, e(1000)))
      .to.emit(pool, "Liquidated");
    // 550 x 1.05 / 7 = 82.5 mCOL
    expect(await collateral.balanceOf(liquidator.address)).to.be.closeTo(e("82.5"), TOLERANCE);
    const pos = await pool.positions(borrower.address);
    expect(pos.debt).to.equal(0n);
    expect(pos.collateral).to.be.closeTo(e("17.5"), TOLERANCE);
    expect(await pool.totalBadDebt()).to.equal(0n);
  });

  it("9. records bad debt when the collateral does not cover the debt", async function () {
    const { pool, oracle, collateral, borrower, liquidator } = await loadFixture(borrowedFixture);
    await oracle.setPrice(e(5)); // collateral now worth 500 mUSD < 550 debt
    await pool.connect(liquidator).liquidate(borrower.address, e(1000));

    // liquidator pays 100 x 5 / 1.05 = 476.19 and gets all 100 mCOL; 550 - 476.19 = 73.81 is bad debt
    expect(await collateral.balanceOf(liquidator.address)).to.equal(e(100));
    expect(await pool.totalBadDebt()).to.be.closeTo(e("73.81"), TOLERANCE);
    const pos = await pool.positions(borrower.address);
    expect(pos.debt).to.equal(0n);
    expect(pos.collateral).to.equal(0n);
  });

  it("10. only the pauser can pause, and a pause stops user actions", async function () {
    const { pool, admin, borrower, stranger } = await loadFixture(deployFixture);
    await expect(pool.connect(stranger).pause())
      .to.be.revertedWithCustomError(pool, "AccessControlUnauthorizedAccount")
      .withArgs(stranger.address, await pool.PAUSER_ROLE());

    await pool.connect(admin).pause();
    await expect(pool.connect(borrower).depositCollateral(e(1)))
      .to.be.revertedWithCustomError(pool, "EnforcedPause");

    await pool.connect(admin).unpause();
    await expect(pool.connect(borrower).depositCollateral(e(1))).to.emit(pool, "CollateralDeposited");
  });

  it("11. rejects a stale oracle price", async function () {
    const { pool, oracle, borrower } = await loadFixture(deployFixture);
    await pool.connect(borrower).depositCollateral(e(100));
    await time.increase(2 * 60 * 60); // price is now 2 hours old (max 1 hour)
    await expect(pool.connect(borrower).borrow(e(100))).to.be.revertedWith("stale price");

    await oracle.setPrice(e(10)); // fresh price again
    await expect(pool.connect(borrower).borrow(e(100))).to.emit(pool, "Borrowed");
  });

  it("12. blocks a reentrancy attack from a malicious token", async function () {
    const { stable, oracle, admin, borrower } = await loadFixture(deployFixture);
    const bad = await (await ethers.getContractFactory("ReentrantToken")).deploy();
    const pool = await (await ethers.getContractFactory("QorLendPool")).deploy(
      bad.target, stable.target, oracle.target, admin.address);

    await bad.mint(borrower.address, e(10));
    await bad.connect(borrower).approve(pool.target, e(10));
    await bad.setTarget(pool.target); // the token calls the pool again during transferFrom

    await expect(pool.connect(borrower).depositCollateral(e(10)))
      .to.be.revertedWithCustomError(pool, "ReentrancyGuardReentrantCall");
    expect((await pool.positions(borrower.address)).collateral).to.equal(0n);
  });
});
