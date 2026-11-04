// S10 Plasma Vault operations: read the DAO fee package, set management and performance fees, watch them
// accrue and harvest them, cap the supply and turn on share transfers.
// It stands alone: step 01 repeats S1's clone, Atomist grant and public switch in short, without a market,
// so the Plasma Vault runs on idle USDC.
// Every step is a real transaction on a Base fork, and a step depends on the steps above it.
// The story skips simulation on purpose, to show the transaction flow. A real app on a real
// chain should simulate before each transaction, to check gas usage and whether it reverts.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { erc20Abi, maxUint256, parseEther, parseEventLogs, parseUnits, toFunctionSelector, type Address } from "viem";
import { accessManagerAbi } from "../abis/access-manager.abi.ts";
import { factoryAbi } from "../abis/factory.abi.ts";
import { factoryFeeAbi } from "../abis/factory-fee.abi.ts";
import { feeManagerAbi } from "../abis/fee-manager.abi.ts";
import { plasmaVaultAbi } from "../abis/plasma-vault.abi.ts";

// Base addresses, from ipor-abi: mainnet/mainnet-base-fusion/addresses.json at 8b1be92 (factory) and README.md (USDC).
const FACTORY = "0x1455717668fA96534f675856347A973fA907e922";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// USDC has 6 decimals.
const USDC_DECIMALS = 6;
// Plasma Vault shares have the asset's decimals plus 2.
const PLASMA_VAULT_SHARE_DECIMALS = 8;
const PLASMA_VAULT_NAME = "Story USDC";
const PLASMA_VAULT_SYMBOL = "sUSDC";
const REDEMPTION_DELAY = 0n;
const DAO_FEE_PACKAGE_INDEX = 0n;
// An EOA holding about 158.3M USDC at the fork block, used to fund the depositor.
const USDC_WHALE = "0x8da91A6298eA5d1A8Bc985e99798fd0A0f05701a";

// Role IDs from Roles.sol (ipor-fusion 4fdaf50).
const ATOMIST_ROLE = 100n;
const PUBLIC_ROLE = 2n ** 64n - 1n;

// Hardhat's default accounts. The fee recipient, the harvester and the share receiver hold no role.
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ATOMIST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DEPOSITOR = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const FEE_RECIPIENT = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
const HARVESTER = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";
const SHARE_RECEIVER = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";

const ONE_YEAR = 365 * 24 * 60 * 60;

const DEPOSIT_SELECTOR = toFunctionSelector("deposit(uint256,address)");
// grantRole: the grant takes effect without an execution delay.
const NO_EXECUTION_DELAY = 0;
const MANAGEMENT_FEE_BPS = 200n;
const PERFORMANCE_FEE_BPS = 1000n;
// Fee package 0 of the factory, the DAO's cut.
const DAO_MANAGEMENT_FEE_BPS = 5n;
const DAO_PERFORMANCE_FEE_BPS = 1000n;
const OVER_LIMIT_MANAGEMENT_FEE_BPS = 600n;
const amount2000Usdc = parseUnits("2000", USDC_DECIMALS);
const amount1000Usdc = parseUnits("1000", USDC_DECIMALS);
const amount100Usdc = parseUnits("100", USDC_DECIMALS);
const amount1Usdc = parseUnits("1", USDC_DECIMALS);
const amount50Shares = parseUnits("50", PLASMA_VAULT_SHARE_DECIMALS);

const amount10Shares = parseUnits("10", PLASMA_VAULT_SHARE_DECIMALS);

const GAS_TOP_UP = parseEther("1");
// Totals add the DAO fee package to the recipient's fee.
const TOTAL_MANAGEMENT_FEE_BPS = DAO_MANAGEMENT_FEE_BPS + MANAGEMENT_FEE_BPS;
const TOTAL_PERFORMANCE_FEE_BPS = DAO_PERFORMANCE_FEE_BPS + PERFORMANCE_FEE_BPS;

const { viem, networkHelpers } = await network.create("base");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const depositor = await viem.getWalletClient(DEPOSITOR);
const harvester = await viem.getWalletClient(HARVESTER);

describe("S10 Operate a USDC Plasma Vault: fees, supply cap and share transfers", () => {
  let plasmaVault: Address, feeManager: Address;

  before(async () => {
    // Only the USDC whale needs impersonating: every other account is an unlocked Hardhat default account.
    await networkHelpers.impersonateAccount(USDC_WHALE);
    // Gives the whale ETH to pay gas for its USDC transfer.
    await networkHelpers.setBalance(USDC_WHALE, GAS_TOP_UP);
    const whale = await viem.getWalletClient(USDC_WHALE);
    await whale.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "transfer",
      args: [DEPOSITOR, amount2000Usdc],
    });
  });

  it("01 clones a Plasma Vault on DAO fee package 0, grants Atomist, goes public and takes a deposit, as in S1", async () => {
    // The last clone argument picks the DAO fee package by index.
    const hash = await owner.writeContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: "clone",
      args: [
        PLASMA_VAULT_NAME,
        PLASMA_VAULT_SYMBOL,
        USDC,
        REDEMPTION_DELAY,
        OWNER,
        DAO_FEE_PACKAGE_INDEX,
      ],
    });
    const { logs } = await publicClient.waitForTransactionReceipt({ hash });
    const [created] = parseEventLogs({ abi: factoryAbi, logs, eventName: "FusionInstanceCreated" });
    assert.ok(created, "the receipt has no FusionInstanceCreated event");
    plasmaVault = created.args.plasmaVault;
    feeManager = created.args.feeManager;
    const accessManager = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "getAccessManagerAddress",
    });
    const [[atomistHadRole], depositRoleBefore] = await Promise.all([
      publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "hasRole",
        args: [ATOMIST_ROLE, ATOMIST],
      }),
      publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "getTargetFunctionRole",
        args: [plasmaVault, DEPOSIT_SELECTOR],
      }),
    ]);
    assert.equal(atomistHadRole, false);
    assert.notEqual(depositRoleBefore, PUBLIC_ROLE);
    const [depositorAllowance, depositorSharesBefore] = await Promise.all([
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "allowance",
        args: [DEPOSITOR, plasmaVault],
      }),
      publicClient.readContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
    ]);
    assert.equal(depositorAllowance, 0n);
    assert.equal(depositorSharesBefore, 0n);
    // On the access manager: the Atomist unlocks the fee, supply cap and transfer settings below.
    await owner.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [ATOMIST_ROLE, ATOMIST, NO_EXECUTION_DELAY],
    });
    await atomist.writeContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "convertToPublicVault",
    });
    await depositor.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "approve",
      args: [plasmaVault, amount2000Usdc],
    });
    await depositor.writeContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "deposit",
      args: [amount1000Usdc, DEPOSITOR],
    });

    const [depositorShares, [atomistHasRole], depositRole] = await Promise.all([
      publicClient.readContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
      publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "hasRole",
        args: [ATOMIST_ROLE, ATOMIST],
      }),
      publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "getTargetFunctionRole",
        args: [plasmaVault, DEPOSIT_SELECTOR],
      }),
    ]);
    assert.ok(depositorShares > 0n);
    assert.equal(atomistHasRole, true);
    assert.equal(depositRole, PUBLIC_ROLE);
    // The deposit spent 1000 of the 2000 USDC approved.
    const depositorAllowanceUsdc = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [DEPOSITOR, plasmaVault],
    });
    assert.equal(depositorAllowanceUsdc, amount1000Usdc);
  });

  it("02 reads the DAO fee package the Plasma Vault was cloned with", async () => {
    // Fees are in basis points: 10000 = 100%. The DAO takes its share before any fee the Atomist sets.
    const [daoFeePackage] = await publicClient.readContract({
      address: FACTORY,
      abi: factoryFeeAbi,
      functionName: "getDaoFeePackages",
    });
    assert.ok(daoFeePackage, "the factory has no DAO fee package");
    assert.equal(daoFeePackage.managementFee, DAO_MANAGEMENT_FEE_BPS);
    assert.equal(daoFeePackage.performanceFee, DAO_PERFORMANCE_FEE_BPS);
    const [totalManagementFee, totalPerformanceFee] = await Promise.all([
      publicClient.readContract({
        address: feeManager,
        abi: feeManagerAbi,
        functionName: "getTotalManagementFee",
      }),
      publicClient.readContract({
        address: feeManager,
        abi: feeManagerAbi,
        functionName: "getTotalPerformanceFee",
      }),
    ]);
    assert.equal(totalManagementFee, DAO_MANAGEMENT_FEE_BPS);
    assert.equal(totalPerformanceFee, DAO_PERFORMANCE_FEE_BPS);
  });

  it("03 the Atomist sets a 200 bps management and 1000 bps performance fee for a recipient", async () => {
    // Each call replaces the whole recipient list. It harvests only the fees already realized as shares in the fee account.
    // The fee accrued since the last realization goes to the new recipients, unless a deposit or withdraw realizes it first.
    const [totalManagementFeeBefore, totalPerformanceFeeBefore] = await Promise.all([
      publicClient.readContract({
        address: feeManager,
        abi: feeManagerAbi,
        functionName: "getTotalManagementFee",
      }),
      publicClient.readContract({
        address: feeManager,
        abi: feeManagerAbi,
        functionName: "getTotalPerformanceFee",
      }),
    ]);
    assert.equal(totalManagementFeeBefore, DAO_MANAGEMENT_FEE_BPS);
    assert.equal(totalPerformanceFeeBefore, DAO_PERFORMANCE_FEE_BPS);
    await atomist.writeContract({
      address: feeManager,
      abi: feeManagerAbi,
      functionName: "updateManagementFee",
      args: [[{ recipient: FEE_RECIPIENT, feeValue: MANAGEMENT_FEE_BPS }]],
    });
    await atomist.writeContract({
      address: feeManager,
      abi: feeManagerAbi,
      functionName: "updatePerformanceFee",
      args: [[{ recipient: FEE_RECIPIENT, feeValue: PERFORMANCE_FEE_BPS }]],
    });

    // The totals add the DAO fee: 5 + 200 and 1000 + 1000.
    const [totalManagementFee, totalPerformanceFee] = await Promise.all([
      publicClient.readContract({
        address: feeManager,
        abi: feeManagerAbi,
        functionName: "getTotalManagementFee",
      }),
      publicClient.readContract({
        address: feeManager,
        abi: feeManagerAbi,
        functionName: "getTotalPerformanceFee",
      }),
    ]);
    assert.equal(totalManagementFee, TOTAL_MANAGEMENT_FEE_BPS);
    assert.equal(totalPerformanceFee, TOTAL_PERFORMANCE_FEE_BPS);
    await assert.rejects(
      // Expected to revert: the 500 bps management limit (5000 for performance) counts the DAO fee, so 600 + 5 = 605.
      atomist.writeContract({
        address: feeManager,
        abi: feeManagerAbi,
        functionName: "updateManagementFee",
        args: [[{ recipient: FEE_RECIPIENT, feeValue: OVER_LIMIT_MANAGEMENT_FEE_BPS }]],
      }),
      /InvalidManagementFee.*605/s,
    );
  });

  it("04 the management fee accrues over a year and a deposit mints it as fee shares", async () => {
    const managementFeeAccount = await publicClient.readContract({
      address: feeManager,
      abi: feeManagerAbi,
      functionName: "MANAGEMENT_FEE_ACCOUNT",
    });
    const sharesBefore = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "balanceOf",
      args: [managementFeeAccount],
    });
    await networkHelpers.time.increase(ONE_YEAR);

    // In USDC, before any fee share exists. Deposit, mint, withdraw and redeem realize it.
    assert.ok((await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "getUnrealizedManagementFee",
    })) > 0n);
    await depositor.writeContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "deposit",
      args: [amount100Usdc, DEPOSITOR],
    });
    const [managementFeeAccountShares, unrealizedManagementFee] = await Promise.all([
      publicClient.readContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "balanceOf",
        args: [managementFeeAccount],
      }),
      publicClient.readContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "getUnrealizedManagementFee",
      }),
    ]);
    assert.ok(managementFeeAccountShares > sharesBefore);
    assert.equal(unrealizedManagementFee, 0n);
  });

  it("05 a gain above the high-water mark mints the performance fee on a withdraw", async () => {
    const performanceFeeAccount = await publicClient.readContract({
      address: feeManager,
      abi: feeManagerAbi,
      functionName: "PERFORMANCE_FEE_ACCOUNT",
    });
    const sharesBefore = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "balanceOf",
      args: [performanceFeeAccount],
    });
    // A USDC donation to the Plasma Vault stands in for a gain. Real gains come from markets (S7).
    const idleBefore = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [plasmaVault],
    });
    await depositor.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "transfer",
      args: [plasmaVault, amount100Usdc],
    });
    const idleAfterDonation = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [plasmaVault],
    });
    assert.equal(idleAfterDonation - idleBefore, amount100Usdc);
    // Withdraw, redeem, execute and updateMarketsBalances realize the performance fee. A deposit does not.
    await depositor.writeContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "withdraw",
      args: [amount1Usdc, DEPOSITOR, DEPOSITOR],
    });

    const performanceFeeAccountShares = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "balanceOf",
      args: [performanceFeeAccount],
    });
    assert.ok(performanceFeeAccountShares > sharesBefore);
  });

  it("06 an account with no role harvests the fees to the recipient and the DAO", async () => {
    const [dao, recipientBefore] = await Promise.all([
      publicClient.readContract({
        address: feeManager,
        abi: feeManagerAbi,
        functionName: "getIporDaoFeeRecipientAddress",
      }),
      publicClient.readContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "balanceOf",
        args: [FEE_RECIPIENT],
      }),
    ]);
    const [daoBefore, managementFeeAccount, performanceFeeAccount, supplyBefore] = await Promise.all([
      publicClient.readContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "balanceOf",
        args: [dao],
      }),
      publicClient.readContract({
        address: feeManager,
        abi: feeManagerAbi,
        functionName: "MANAGEMENT_FEE_ACCOUNT",
      }),
      publicClient.readContract({
        address: feeManager,
        abi: feeManagerAbi,
        functionName: "PERFORMANCE_FEE_ACCOUNT",
      }),
      publicClient.readContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "totalSupply",
      }),
    ]);
    // harvestAllFees has no role, so a keeper can automate it. It moves shares out of the fee accounts and mints nothing.
    // The fee manager moves them, and it is the only holder of the share transfer role, so this works before enableTransferShares.
    await harvester.writeContract({
      address: feeManager,
      abi: feeManagerAbi,
      functionName: "harvestAllFees",
    });

    const [performanceFeeAccountShares, feeRecipientShares, daoShares] = await Promise.all([
      publicClient.readContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "balanceOf",
        args: [performanceFeeAccount],
      }),
      publicClient.readContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "balanceOf",
        args: [FEE_RECIPIENT],
      }),
      publicClient.readContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "balanceOf",
        args: [dao],
      }),
    ]);
    const totalSupplyShares = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "totalSupply",
    });
    assert.equal(totalSupplyShares, supplyBefore);
    // The recipient shares round down, so a few wei of shares (22 here) stay in a fee account.
    const managementFeeAccountShares = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "balanceOf",
      args: [managementFeeAccount],
    });
    assert.ok(managementFeeAccountShares < 100n);
    assert.ok(performanceFeeAccountShares < 100n);
    assert.ok(feeRecipientShares > recipientBefore);
    assert.ok(daoShares > daoBefore);
  });

  it("07 the Atomist caps the supply in shares and a deposit above the room reverts", async () => {
    // The cap counts shares, with 8 decimals (USDC's 6 plus the Plasma Vault's offset of 2). It defaults to the uint256 maximum.
    const totalSupply = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "totalSupply",
    });
    const totalSupplyCapBefore = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "getTotalSupplyCap",
    });
    assert.equal(totalSupplyCapBefore, maxUint256);
    await atomist.writeContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "setTotalSupplyCap",
      args: [totalSupply + amount50Shares],
    });
    const totalSupplyCapAfter = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "getTotalSupplyCap",
    });
    assert.equal(totalSupplyCapAfter, totalSupply + amount50Shares);

    // maxDeposit gives the room left in assets, the value a deposit should show.
    const maxDeposit = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "maxDeposit",
      args: [DEPOSITOR],
    });
    assert.ok(maxDeposit > 0n && maxDeposit < amount100Usdc);
    await assert.rejects(
      // Expected to revert: the deposit is 1 USDC over the room left.
      depositor.writeContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "deposit",
        args: [maxDeposit + amount1Usdc, DEPOSITOR],
      }),
      /ERC4626ExceededMaxDeposit/,
    );
  });

  it("08 share transfers are off until the Atomist enables them", async () => {
    await assert.rejects(
      // Expected to revert: a new Plasma Vault restricts transfer and transferFrom to TECH_VAULT_TRANSFER_SHARES_ROLE (7).
      // Only the fee manager holds it, which is why step 06's harvest moves shares before enableTransferShares.
      depositor.writeContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "transfer",
        args: [SHARE_RECEIVER, amount10Shares],
      }),
      /AccessManagedUnauthorized/,
    );
    // Opens transfer and transferFrom to everyone. There is no call to turn them off again.
    await atomist.writeContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "enableTransferShares",
    });
    const shareReceiverSharesBalance = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "balanceOf",
      args: [SHARE_RECEIVER],
    });
    assert.equal(shareReceiverSharesBalance, 0n);
    await depositor.writeContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "transfer",
      args: [SHARE_RECEIVER, amount10Shares],
    });

    const shareReceiverShares = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "balanceOf",
      args: [SHARE_RECEIVER],
    });
    assert.equal(shareReceiverShares, amount10Shares);
  });
});
