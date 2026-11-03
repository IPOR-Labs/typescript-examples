// S11 Governance: an execution delay floor, a timelocked Atomist, schedule and execute,
// a Guardian cancelling a scheduled call, and a Guardian pausing and unpausing the Plasma Vault.
// It stands alone: step 01 repeats S1's clone, Atomist grant and convertToPublicVault in short,
// with no market: every deposit stays idle in the Plasma Vault.
// Every step is a real transaction on a Base fork, and a step depends on the steps above it.
// The story skips simulation on purpose, to show the transaction flow. A real app on a real
// chain should simulate before each transaction, to check gas usage and whether it reverts.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import {
  encodeFunctionData,
  erc20Abi,
  maxUint256,
  parseEther,
  parseEventLogs,
  parseUnits,
  toFunctionSelector,
  type Address,
} from "viem";
import { accessManagerAbi } from "../abis/access-manager.abi.ts";
import { factoryAbi } from "../abis/factory.abi.ts";
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
// An EOA holding about 158.3M USDC at the fork block funds the depositor.
const USDC_WHALE = "0x8da91A6298eA5d1A8Bc985e99798fd0A0f05701a";

// Role IDs from Roles.sol (ipor-fusion 4fdaf50).
const ATOMIST_ROLE = 100n;
const GUARDIAN_ROLE = 2n;
const PUBLIC_ROLE = 2n ** 64n - 1n;

// Hardhat's default accounts, one per role.
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ATOMIST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const SECOND_ATOMIST = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const DEPOSITOR = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const GUARDIAN = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";

const ONE_HOUR = 3600;

const DEPOSIT_SELECTOR = toFunctionSelector("deposit(uint256,address)");
// grantRole: the grant takes effect without an execution delay.
const NO_EXECUTION_DELAY = 0;
// schedule: 0 means now plus the caller's delay.
const SCHEDULE_AT_EARLIEST = 0;
const amount1000Usdc = parseUnits("1000", USDC_DECIMALS);
const amount100Usdc = parseUnits("100", USDC_DECIMALS);
const amount200Usdc = parseUnits("200", USDC_DECIMALS);
const amount1000000Shares = parseUnits("1000000", PLASMA_VAULT_SHARE_DECIMALS);
const amount1Shares = parseUnits("1", PLASMA_VAULT_SHARE_DECIMALS);

const GAS_TOP_UP = parseEther("1");

const { viem, networkHelpers } = await network.create("base");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const depositor = await viem.getWalletClient(DEPOSITOR);
const guardian = await viem.getWalletClient(GUARDIAN);

describe("S11 Govern a USDC Plasma Vault: timelock, cancel and pause", () => {
  let plasmaVault: Address, accessManager: Address;

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
      args: [DEPOSITOR, amount1000Usdc],
    });
  });

  it("01 clones a Plasma Vault, grants Atomist and opens deposits to everyone, as in S1", async () => {
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
    accessManager = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "getAccessManagerAddress",
    });
    const atomistMembershipBefore = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [ATOMIST_ROLE, ATOMIST],
    });
    assert.deepEqual(atomistMembershipBefore, [false, 0]);
    const depositRoleBefore = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "getTargetFunctionRole",
      args: [plasmaVault, DEPOSIT_SELECTOR],
    });
    assert.notEqual(depositRoleBefore, PUBLIC_ROLE);
    const depositorAllowanceUsdcBefore = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [DEPOSITOR, plasmaVault],
    });
    assert.equal(depositorAllowanceUsdcBefore, 0n);
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
      args: [plasmaVault, amount1000Usdc],
    });

    const [atomistMembership, depositRole] = await Promise.all([
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
    assert.deepEqual(atomistMembership, [true, 0]);
    assert.equal(depositRole, PUBLIC_ROLE);
    const depositorAllowanceUsdcAfter = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [DEPOSITOR, plasmaVault],
    });
    assert.equal(depositorAllowanceUsdcAfter, amount1000Usdc);
  });

  it("02 the Owner sets a one-hour floor for Atomist, which binds only new grants", async () => {
    // On the Plasma Vault, Owner only: the minimal execution delay a new grant of each role must carry.
    const atomistExecutionDelaySecondsBefore = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "getMinimalExecutionDelayForRole",
      args: [ATOMIST_ROLE],
    });
    assert.equal(atomistExecutionDelaySecondsBefore, 0n);
    await owner.writeContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "setMinimalExecutionDelaysForRoles",
      args: [[ATOMIST_ROLE], [BigInt(ONE_HOUR)]],
    });
    const atomistExecutionDelaySecondsAfter = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "getMinimalExecutionDelayForRole",
      args: [ATOMIST_ROLE],
    });
    assert.equal(atomistExecutionDelaySecondsAfter, BigInt(ONE_HOUR));
    // The existing Atomist keeps delay 0: a floor alone timelocks no one.
    const atomistMembership = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [ATOMIST_ROLE, ATOMIST],
    });
    assert.deepEqual(atomistMembership, [true, 0]);
    await assert.rejects(
      // Expected to revert: a new Atomist grant below the floor.
      owner.writeContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "grantRole",
        args: [ATOMIST_ROLE, SECOND_ATOMIST, NO_EXECUTION_DELAY],
      }),
      /TooShortExecutionDelayForRole/,
    );
  });

  it("03 the Owner re-grants Atomist with a one-hour delay", async () => {
    // A timelock is applied per account, by granting the role again with an execution delay.
    const atomistMembershipBefore = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [ATOMIST_ROLE, ATOMIST],
    });
    assert.deepEqual(atomistMembershipBefore, [true, 0]);
    await owner.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [ATOMIST_ROLE, ATOMIST, ONE_HOUR],
    });

    const atomistMembershipAfter = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [ATOMIST_ROLE, ATOMIST],
    });
    assert.deepEqual(atomistMembershipAfter, [true, ONE_HOUR]);
  });

  it("04 a direct Atomist call now reverts", async () => {
    await assert.rejects(
      // Expected to revert: a delayed role must schedule its calls first.
      atomist.writeContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "setTotalSupplyCap",
        args: [amount1000000Shares],
      }),
      /AccessManagerNotScheduled/,
    );
  });

  it("05 the Atomist schedules the call, waits out the delay and executes it", async () => {
    const data = encodeFunctionData({
      abi: plasmaVaultAbi,
      functionName: "setTotalSupplyCap",
      args: [amount1000000Shares],
    });
    // The access manager keys a scheduled call by the caller, the target and the calldata.
    const operationId = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hashOperation",
      args: [ATOMIST, plasmaVault, data],
    });
    const operationScheduleBefore = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "getSchedule",
      args: [operationId],
    });
    assert.equal(operationScheduleBefore, 0);
    // On the access manager: when 0 means now plus the caller's delay.
    await atomist.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "schedule",
      args: [plasmaVault, data, SCHEDULE_AT_EARLIEST],
    });
    assert.ok((await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "getSchedule",
      args: [operationId],
    })) > 0);
    await assert.rejects(
      // Expected to revert: the delay has not passed yet.
      atomist.writeContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "execute",
        args: [plasmaVault, data],
      }),
      /AccessManagerNotReady/,
    );

    await networkHelpers.time.increase(ONE_HOUR);
    const totalSupplyCapBefore = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "getTotalSupplyCap",
    });
    assert.equal(totalSupplyCapBefore, maxUint256);
    // Only the account that scheduled the call may execute it.
    await atomist.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "execute",
      args: [plasmaVault, data],
    });

    const totalSupplyCapAfter = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "getTotalSupplyCap",
    });
    assert.equal(totalSupplyCapAfter, amount1000000Shares);
    // Execute consumes the schedule.
    const operationScheduleAfter = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "getSchedule",
      args: [operationId],
    });
    assert.equal(operationScheduleAfter, 0);
  });

  it("06 the Owner grants Guardian, and the Guardian cancels a scheduled call", async () => {
    // Guardian is administered by the Owner and guards every function role, so it may cancel any scheduled call.
    const guardianMembershipBefore = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [GUARDIAN_ROLE, GUARDIAN],
    });
    assert.deepEqual(guardianMembershipBefore, [false, 0]);
    await owner.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [GUARDIAN_ROLE, GUARDIAN, NO_EXECUTION_DELAY],
    });
    const data = encodeFunctionData({
      abi: plasmaVaultAbi,
      functionName: "setTotalSupplyCap",
      args: [amount1Shares],
    });
    const operationId = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hashOperation",
      args: [ATOMIST, plasmaVault, data],
    });
    const operationScheduleBefore = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "getSchedule",
      args: [operationId],
    });
    assert.equal(operationScheduleBefore, 0);
    await atomist.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "schedule",
      args: [plasmaVault, data, SCHEDULE_AT_EARLIEST],
    });
    assert.ok((await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "getSchedule",
      args: [operationId],
    })) > 0);

    // cancel names the account that scheduled the call, the target and the calldata.
    await guardian.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "cancel",
      args: [ATOMIST, plasmaVault, data],
    });
    const operationScheduleAfter = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "getSchedule",
      args: [operationId],
    });
    assert.equal(operationScheduleAfter, 0);
    await networkHelpers.time.increase(ONE_HOUR);

    const guardianMembershipAfter = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [GUARDIAN_ROLE, GUARDIAN],
    });
    assert.deepEqual(guardianMembershipAfter, [true, 0]);
    await assert.rejects(
      // Expected to revert: the cancelled call is no longer scheduled.
      atomist.writeContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "execute",
        args: [plasmaVault, data],
      }),
      /AccessManagerNotScheduled/,
    );
    const totalSupplyCap = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "getTotalSupplyCap",
    });
    assert.equal(totalSupplyCap, amount1000000Shares);
  });

  it("07 the Guardian pauses the Plasma Vault, views still answer, then unpauses it", async () => {
    const totalAssetsBeforeDeposit = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "totalAssets",
    });
    assert.equal(totalAssetsBeforeDeposit, 0n);
    await depositor.writeContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "deposit",
      args: [amount100Usdc, DEPOSITOR],
    });
    // On the access manager: closing the Plasma Vault as a target blocks every restricted Plasma Vault call,
    // deposit, withdraw, transfer, schedule and harvestAllFees included. The Plasma Vault has no pause() of its own.
    const [totalAssets, targetClosed] = await Promise.all([
      publicClient.readContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "totalAssets",
      }),
      publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "isTargetClosed",
        args: [plasmaVault],
      }),
    ]);
    assert.equal(totalAssets, amount100Usdc);
    assert.equal(targetClosed, false);
    await guardian.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "updateTargetClosed",
      args: [plasmaVault, true],
    });

    const targetClosedAfterPause = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "isTargetClosed",
      args: [plasmaVault],
    });
    assert.equal(targetClosedAfterPause, true);
    await assert.rejects(
      // Expected to revert: the Plasma Vault is closed.
      depositor.writeContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "deposit",
        args: [amount100Usdc, DEPOSITOR],
      }),
      /AccessManagedUnauthorized/,
    );
    const totalAssetsWhilePaused = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "totalAssets",
    });
    assert.equal(totalAssetsWhilePaused, amount100Usdc);
    // maxDeposit does not know about the pause and stays non-zero: a deposit must check isTargetClosed itself.
    assert.ok((await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "maxDeposit",
      args: [DEPOSITOR],
    })) > 0n);

    await guardian.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "updateTargetClosed",
      args: [plasmaVault, false],
    });
    const targetClosedAfterUnpause = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "isTargetClosed",
      args: [plasmaVault],
    });
    assert.equal(targetClosedAfterUnpause, false);
    await depositor.writeContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "deposit",
      args: [amount100Usdc, DEPOSITOR],
    });

    const totalAssetsAfterUnpause = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "totalAssets",
    });
    assert.equal(totalAssetsAfterUnpause, amount200Usdc);
  });
});
