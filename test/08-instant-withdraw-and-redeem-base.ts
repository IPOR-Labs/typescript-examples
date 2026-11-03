// S8 Instant withdraw and redeem: withdraw from idle funds, see the shortfall revert, then add an
// instant-withdrawal fuse that unwinds Aave V3 on demand, and see how the withdraw fee behaves.
// It follows S1: steps 01 and 02 repeat S1's setup in short, then a depositor funds the vault.
// Every step is a real transaction on a Base fork, and a step depends on the steps above it.
// The story skips simulation on purpose, to show the transaction flow. A real app on a real
// chain should simulate before each transaction, to check gas usage and whether it reverts.
// A client finds "Max instant withdraw" by a binary search of simulated withdrawals. Steps 04 and 08
// show the replacements: a formula without instant-withdrawal fuses, a real redeem in a snapshot with them.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseEther,
  parseEventLogs,
  parseUnits,
  pad,
  slice,
  toFunctionSelector,
  isAddressEqual,
  zeroAddress,
  zeroHash,
  type Address,
} from "viem";
import { aaveV3SupplyFuseAbi } from "../abis/aaveV3SupplyFuse.abi.ts";
import { accessManagerAbi } from "../abis/accessManager.abi.ts";
import { factoryAbi } from "../abis/factory.abi.ts";
import { vaultAbi } from "../abis/vault.abi.ts";
import { withdrawManagerAbi } from "../abis/withdrawManager.abi.ts";

// Base addresses, from ipor-abi: mainnet/mainnet-base-fusion/addresses.json at 8b1be92 (factory, Aave V3 fuses),
// mainnet/addresses.json at e228075 (BalanceFuseErc20) and README.md (USDC).
const FACTORY = "0x1455717668fA96534f675856347A973fA907e922";
const AAVE_V3_SUPPLY_FUSE = "0x26fD6EF391E98C78CfCA27e00c3d15be4D941625";
const AAVE_V3_BALANCE_FUSE = "0x952573Ec1B6895a88a95CA523097083d4da4D8e5";
const ERC20_BALANCE_FUSE = "0x9ba147FC382DBf4D73512A45370ba0B70c25F6aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// USDC has 6 decimals.
const USDC_DECIMALS = 6;
const VAULT_NAME = "Story USDC";
const VAULT_SYMBOL = "sUSDC";
const REDEMPTION_DELAY = 0n;
const DAO_FEE_PACKAGE_INDEX = 0n;
// An EOA that holds enough USDC on Base at the fork block to fund the depositor.
const USDC_WHALE = "0x8da91A6298eA5d1A8Bc985e99798fd0A0f05701a";
// The vault keeps its Withdraw Manager address in this storage slot and has no getter for it
// (WITHDRAW_MANAGER in contracts/libraries/PlasmaVaultStorageLib.sol:722, ipor-fusion 004d054).
const WITHDRAW_MANAGER_SLOT = "0x465d2ff0062318fe6f4c7e9ac78cfcd70bc86a1d992722875ef83a9770513100";

// Market IDs from IporFusionMarkets.sol (ipor-fusion 004d054) and role IDs from Roles.sol (ipor-fusion 4fdaf50).
const AAVE_V3_MARKET = 1n;
const ERC20_VAULT_BALANCE_MARKET = 7n;
const ATOMIST_ROLE = 100n;
const ALPHA_ROLE = 200n;
const FUSE_MANAGER_ROLE = 300n;
const CONFIG_INSTANT_WITHDRAWAL_FUSES_ROLE = 900n;
const WITHDRAW_MANAGER_WITHDRAW_FEE_ROLE = 902n;
const PUBLIC_ROLE = 2n ** 64n - 1n;

// Hardhat's default accounts, one per role.
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ATOMIST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const FUSE_MANAGER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ALPHA = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const DEPOSITOR = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";


// grantRole: the grant takes effect without an execution delay.
const NO_EXECUTION_DELAY = 0;
const DEPOSIT_SELECTOR = toFunctionSelector("deposit(uint256,address)");
// Aave eMode category 0 is no eMode.
const E_MODE_NONE = 0n;
const ONE_WEI = 1n;
const FIRST_PARAMS_INDEX = 0n;
// Fees have 18 decimals: 1e16 is 1%.
const feeOnePercent = parseEther("0.01");
const FEE_DECIMALS = 18n;
const amount1000Usdc = parseUnits("1000", USDC_DECIMALS);
const amount600Usdc = parseUnits("600", USDC_DECIMALS);
const amount400Usdc = parseUnits("400", USDC_DECIMALS);
const amount599Usdc = parseUnits("599", USDC_DECIMALS);
const amount601Usdc = parseUnits("601", USDC_DECIMALS);
const amount200Usdc = parseUnits("200", USDC_DECIMALS);
const amount100Usdc = parseUnits("100", USDC_DECIMALS);

const GAS_TOP_UP = parseEther("1");
// The burned shares are worth 101 USDC within 0.01%.
const BURN_LOWER_BPS = 10099n;
const BURN_UPPER_BPS = 10101n;

const { viem, networkHelpers } = await network.create("base");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const fuseManager = await viem.getWalletClient(FUSE_MANAGER);
const alpha = await viem.getWalletClient(ALPHA);
const depositor = await viem.getWalletClient(DEPOSITOR);

describe("S8 Instant withdraw and redeem on a USDC vault with Aave V3", () => {
  let vault: Address, accessManager: Address, withdrawManager: Address, maxInstant: bigint;

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

  it("01 clones a vault, grants its roles as in S1, and reads the Withdraw Manager from storage", async () => {
    const hash = await owner.writeContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: "clone",
      args: [
        VAULT_NAME,
        VAULT_SYMBOL,
        USDC,
        REDEMPTION_DELAY,
        OWNER,
        DAO_FEE_PACKAGE_INDEX,
      ],
    });
    const { logs } = await publicClient.waitForTransactionReceipt({ hash });
    const [created] = parseEventLogs({ abi: factoryAbi, logs, eventName: "FusionInstanceCreated" });
    assert.ok(created, "the receipt has no FusionInstanceCreated event");
    vault = created.args.plasmaVault;
    accessManager = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "getAccessManagerAddress",
    });
    const [[atomistHadRole], [fuseManagerHadRole], [alphaHadRole]] = await Promise.all([
      publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "hasRole",
        args: [ATOMIST_ROLE, ATOMIST],
      }),
      publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "hasRole",
        args: [FUSE_MANAGER_ROLE, FUSE_MANAGER],
      }),
      publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "hasRole",
        args: [ALPHA_ROLE, ALPHA],
      }),
    ]);
    assert.equal(atomistHadRole, false);
    assert.equal(fuseManagerHadRole, false);
    assert.equal(alphaHadRole, false);
    // On the access manager: the Owner grants the Atomist role, which unlocks role grants and convertToPublicVault on the vault.
    await owner.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [ATOMIST_ROLE, ATOMIST, NO_EXECUTION_DELAY],
    });
    // On the access manager: Fuse Manager unlocks addFuses and grantMarketSubstrates on the vault.
    await atomist.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [FUSE_MANAGER_ROLE, FUSE_MANAGER, NO_EXECUTION_DELAY],
    });
    // On the access manager: Alpha unlocks execute on the vault.
    await atomist.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [ALPHA_ROLE, ALPHA, NO_EXECUTION_DELAY],
    });
    const [[atomistHasRole], [fuseManagerHasRole], [alphaHasRole]] = await Promise.all([
      publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "hasRole",
        args: [ATOMIST_ROLE, ATOMIST],
      }),
      publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "hasRole",
        args: [FUSE_MANAGER_ROLE, FUSE_MANAGER],
      }),
      publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "hasRole",
        args: [ALPHA_ROLE, ALPHA],
      }),
    ]);
    assert.equal(atomistHasRole, true);
    assert.equal(fuseManagerHasRole, true);
    assert.equal(alphaHasRole, true);
    // The event omits the Withdraw Manager and clone's return value needs a simulation, so read the slot.
    // The slot holds the address left-padded to 32 bytes.
    const word = await publicClient.getStorageAt({ address: vault, slot: WITHDRAW_MANAGER_SLOT });
    assert.ok(word && word !== zeroHash, "the vault has no Withdraw Manager");
    withdrawManager = getAddress(slice(word, 12));

    assert.notEqual(vault, zeroAddress);
    assert.ok(isAddressEqual(await publicClient.readContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "getPlasmaVaultAddress",
    }), vault));
  });

  it("02 installs Aave V3 and opens deposits to everyone, as in S1", async () => {
    const usdcSubstrate = pad(USDC, { size: 32 });
    const [
      aaveV3SupplyFuseSupportedBefore,
      aaveV3BalanceFuseSupportedBefore,
      erc20BalanceFuseSupportedBefore,
      aaveV3MarketUsdcSubstrateGrantedBefore,
      erc20VaultBalanceMarketUsdcSubstrateGrantedBefore,
      aaveV3MarketDependencyBalanceGraphBefore,
      depositTargetFunctionRoleBefore,
    ] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "isFuseSupported",
        args: [AAVE_V3_SUPPLY_FUSE],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "isBalanceFuseSupported",
        args: [AAVE_V3_MARKET, AAVE_V3_BALANCE_FUSE],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "isBalanceFuseSupported",
        args: [ERC20_VAULT_BALANCE_MARKET, ERC20_BALANCE_FUSE],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "isMarketSubstrateGranted",
        args: [AAVE_V3_MARKET, usdcSubstrate],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "isMarketSubstrateGranted",
        args: [ERC20_VAULT_BALANCE_MARKET, usdcSubstrate],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "getDependencyBalanceGraph",
        args: [AAVE_V3_MARKET],
      }),
      publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "getTargetFunctionRole",
        args: [vault, DEPOSIT_SELECTOR],
      }),
    ]);
    assert.equal(aaveV3SupplyFuseSupportedBefore, false);
    assert.equal(aaveV3BalanceFuseSupportedBefore, false);
    assert.equal(erc20BalanceFuseSupportedBefore, false);
    assert.equal(aaveV3MarketUsdcSubstrateGrantedBefore, false);
    assert.equal(erc20VaultBalanceMarketUsdcSubstrateGrantedBefore, false);
    assert.deepEqual(aaveV3MarketDependencyBalanceGraphBefore, []);
    assert.notEqual(depositTargetFunctionRoleBefore, PUBLIC_ROLE);

    await fuseManager.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "addFuses",
      args: [[AAVE_V3_SUPPLY_FUSE]],
    });
    await fuseManager.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "addBalanceFuse",
      args: [AAVE_V3_MARKET, AAVE_V3_BALANCE_FUSE],
    });
    await fuseManager.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "addBalanceFuse",
      args: [ERC20_VAULT_BALANCE_MARKET, ERC20_BALANCE_FUSE],
    });
    await fuseManager.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "grantMarketSubstrates",
      args: [AAVE_V3_MARKET, [usdcSubstrate]],
    });
    await fuseManager.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "grantMarketSubstrates",
      args: [ERC20_VAULT_BALANCE_MARKET, [usdcSubstrate]],
    });
    await fuseManager.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "updateDependencyBalanceGraphs",
      args: [[AAVE_V3_MARKET], [[ERC20_VAULT_BALANCE_MARKET]]],
    });
    await atomist.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "convertToPublicVault",
    });

    const [
      aaveV3SupplyFuseSupported,
      aaveV3BalanceFuseSupported,
      erc20BalanceFuseSupported,
      aaveV3MarketUsdcSubstrateGranted,
      erc20VaultBalanceMarketUsdcSubstrateGranted,
      aaveV3MarketDependencyBalanceGraph,
      depositTargetFunctionRole,
    ] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "isFuseSupported",
        args: [AAVE_V3_SUPPLY_FUSE],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "isBalanceFuseSupported",
        args: [AAVE_V3_MARKET, AAVE_V3_BALANCE_FUSE],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "isBalanceFuseSupported",
        args: [ERC20_VAULT_BALANCE_MARKET, ERC20_BALANCE_FUSE],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "isMarketSubstrateGranted",
        args: [AAVE_V3_MARKET, usdcSubstrate],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "isMarketSubstrateGranted",
        args: [ERC20_VAULT_BALANCE_MARKET, usdcSubstrate],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "getDependencyBalanceGraph",
        args: [AAVE_V3_MARKET],
      }),
      publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "getTargetFunctionRole",
        args: [vault, DEPOSIT_SELECTOR],
      }),
    ]);
    assert.equal(aaveV3SupplyFuseSupported, true);
    assert.equal(aaveV3BalanceFuseSupported, true);
    assert.equal(erc20BalanceFuseSupported, true);
    assert.equal(aaveV3MarketUsdcSubstrateGranted, true);
    assert.equal(erc20VaultBalanceMarketUsdcSubstrateGranted, true);
    assert.deepEqual(aaveV3MarketDependencyBalanceGraph, [ERC20_VAULT_BALANCE_MARKET]);
    assert.equal(depositTargetFunctionRole, PUBLIC_ROLE);
  });

  it("03 a depositor deposits 1000 USDC and the Alpha supplies 600 of it to Aave V3", async () => {
    // S3 explains the deposit, S7 the Alpha's execute call.
    const allowanceBefore = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [DEPOSITOR, vault],
    });
    assert.equal(allowanceBefore, 0n);
    await depositor.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "approve",
      args: [vault, amount1000Usdc],
    });
    const [allowanceAfter, idleBeforeDeposit] = await Promise.all([
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "allowance",
        args: [DEPOSITOR, vault],
      }),
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vault],
      }),
    ]);
    assert.equal(allowanceAfter, amount1000Usdc);
    assert.equal(idleBeforeDeposit, 0n);
    await depositor.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "deposit",
      args: [amount1000Usdc, DEPOSITOR],
    });
    const [idleAfterDeposit, inAaveBefore] = await Promise.all([
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vault],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "totalAssetsInMarket",
        args: [AAVE_V3_MARKET],
      }),
    ]);
    assert.equal(idleAfterDeposit, amount1000Usdc);
    assert.equal(inAaveBefore, 0n);
    const data = encodeFunctionData({
      abi: aaveV3SupplyFuseAbi,
      functionName: "enter",
      args: [{ asset: USDC, amount: amount600Usdc, userEModeCategoryId: E_MODE_NONE }],
    });
    await alpha.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "execute",
      args: [[{ fuse: AAVE_V3_SUPPLY_FUSE, data }]],
    });

    const idle = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [vault],
    });
    assert.equal(idle, amount400Usdc);
    // Aave rounds the aToken balance down by at most a unit or two.
    const inAaveAfter = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "totalAssetsInMarket",
      args: [AAVE_V3_MARKET],
    });
    assert.ok(inAaveAfter >= amount600Usdc - 2n, `in Aave: ${inAaveAfter}`);
  });

  it("04 computes Max instant withdraw from idle funds, with no instant-withdrawal fuses", async () => {
    // Without instant-withdrawal fuses, only idle USDC can pay, less what released requests reserve (S9).
    const depositorShares = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    });
    const [balanceInAssets, sharesToRelease] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "convertToAssets",
        args: [depositorShares],
      }),
      publicClient.readContract({
        address: withdrawManager,
        abi: withdrawManagerAbi,
        functionName: "getSharesToRelease",
      }),
    ]);
    // Assumes no withdraw fee; step 11 covers the fee.
    const [idle, releasedInAssets] = await Promise.all([
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vault],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "convertToAssets",
        args: [sharesToRelease],
      }),
    ]);
    const idleAfterReserve = idle - releasedInAssets;
    const freeIdle = idleAfterReserve > 0n ? idleAfterReserve : 0n;
    maxInstant = balanceInAssets < freeIdle ? balanceInAssets : freeIdle;

    assert.ok(balanceInAssets >= amount1000Usdc - 1n, `balance in assets: ${balanceInAssets}`);
    assert.equal(sharesToRelease, 0n);
    assert.equal(maxInstant, amount400Usdc);
  });

  it("05 a withdraw of one unit more than Max instant reverts in the USDC transfer", async () => {
    // maxWithdraw passes (it ignores liquidity), the vault has no fuse to unwind Aave, so USDC's transfer fails.
    await assert.rejects(depositor.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "withdraw",
      args: [maxInstant + ONE_WEI, DEPOSITOR, DEPOSITOR],
    }), /ERC20: transfer amount exceeds balance/);
  });

  it("06 the depositor withdraws exactly Max instant", async () => {
    const [usdcBefore, idleBefore] = await Promise.all([
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vault],
      }),
    ]);
    assert.equal(idleBefore, maxInstant);
    await depositor.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "withdraw",
      args: [maxInstant, DEPOSITOR, DEPOSITOR],
    });

    const [depositorUsdc, idle] = await Promise.all([
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vault],
      }),
    ]);
    assert.equal(depositorUsdc - usdcBefore, maxInstant);
    assert.equal(idle, 0n);
  });

  it("07 the Atomist grants role 900 and configures the Aave V3 supply fuse as an instant-withdrawal fuse", async () => {
    const [atomistHadRole900] = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [CONFIG_INSTANT_WITHDRAWAL_FUSES_ROLE, ATOMIST],
    });
    assert.equal(atomistHadRole900, false);
    // On the access manager: role 900 unlocks configureInstantWithdrawalFuses on the vault. No address holds it after clone.
    await atomist.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [CONFIG_INSTANT_WITHDRAWAL_FUSES_ROLE, ATOMIST, NO_EXECUTION_DELAY],
    });
    const [[atomistHasRole900], fusesBefore] = await Promise.all([
      publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "hasRole",
        args: [CONFIG_INSTANT_WITHDRAWAL_FUSES_ROLE, ATOMIST],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "getInstantWithdrawalFuses",
      }),
    ]);
    assert.equal(atomistHasRole900, true);
    assert.deepEqual(fusesBefore, []);
    // The fuse's instantWithdraw takes [amount, asset]. params[0] is a placeholder: the vault fills in the amount at withdraw time.
    const params = [zeroHash, pad(USDC, { size: 32 })];
    await atomist.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "configureInstantWithdrawalFuses",
      args: [[{ fuse: AAVE_V3_SUPPLY_FUSE, params }]],
    });

    const fuses = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "getInstantWithdrawalFuses",
    });
    assert.equal(fuses.length, 1);
    assert.ok(fuses[0] && isAddressEqual(fuses[0], AAVE_V3_SUPPLY_FUSE));
    // Params are stored per fuse and per position in the list. The chain returns hex in lower case.
    const stored = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "getInstantWithdrawalFusesParams",
      args: [AAVE_V3_SUPPLY_FUSE, FIRST_PARAMS_INDEX],
    });
    assert.deepEqual(stored, params.map((param) => param.toLowerCase()));
  });

  it("08 reads Max instant withdraw by a real redeem of the whole balance in a snapshot, then reverts it", async () => {
    // With fuses, what the vault can pay depends on the market, so the formula no longer holds: try it for real and undo.
    const [shares, aaveBefore, usdcBefore] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "totalAssetsInMarket",
        args: [AAVE_V3_MARKET],
      }),
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
    ]);
    const snapshot = await networkHelpers.takeSnapshot();
    await depositor.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "redeem",
      args: [shares, DEPOSITOR, DEPOSITOR],
    });
    const depositorUsdc = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    });
    maxInstant = depositorUsdc - usdcBefore;
    await snapshot.restore();

    assert.ok(
      maxInstant > amount599Usdc && maxInstant <= amount601Usdc,
      `max instant: ${maxInstant}`,
    );
    // The snapshot left no trace: same shares, same USDC, same market balance.
    const [depositorShares, depositorUsdc2, inAave] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "totalAssetsInMarket",
        args: [AAVE_V3_MARKET],
      }),
    ]);
    assert.equal(depositorShares, shares);
    assert.equal(depositorUsdc2, usdcBefore);
    assert.equal(inAave, aaveBefore);
  });

  it("09 a withdraw above idle now succeeds and the fuse unwinds Aave V3", async () => {
    const [aaveBefore, usdcBefore, idle] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "totalAssetsInMarket",
        args: [AAVE_V3_MARKET],
      }),
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vault],
      }),
    ]);
    assert.ok(idle < amount200Usdc);
    await depositor.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "withdraw",
      args: [amount200Usdc, DEPOSITOR, DEPOSITOR],
    });

    const [depositorUsdc, aaveAfter] = await Promise.all([
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "totalAssetsInMarket",
        args: [AAVE_V3_MARKET],
      }),
    ]);
    assert.equal(depositorUsdc - usdcBefore, amount200Usdc);
    assert.ok(aaveAfter <= aaveBefore - amount200Usdc, `Aave V3: ${aaveBefore} -> ${aaveAfter}`);
  });

  it("10 the Atomist grants role 902 and sets a 1% withdraw fee", async () => {
    // On the access manager: role 902 unlocks updateWithdrawFee on the Withdraw Manager. The fee has 18 decimals: 1e16 is 1%.
    const [atomistHadRole902] = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [WITHDRAW_MANAGER_WITHDRAW_FEE_ROLE, ATOMIST],
    });
    assert.equal(atomistHadRole902, false);
    await atomist.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [WITHDRAW_MANAGER_WITHDRAW_FEE_ROLE, ATOMIST, NO_EXECUTION_DELAY],
    });
    const [atomistHasRole902] = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [WITHDRAW_MANAGER_WITHDRAW_FEE_ROLE, ATOMIST],
    });
    assert.equal(atomistHasRole902, true);
    const withdrawFeeBefore = await publicClient.readContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "getWithdrawFee",
    });
    assert.equal(withdrawFeeBefore, 0n);
    await atomist.writeContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "updateWithdrawFee",
      args: [feeOnePercent],
    });

    const withdrawFeeAfter = await publicClient.readContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "getWithdrawFee",
    });
    assert.equal(withdrawFeeAfter, feeOnePercent);
  });

  it("11 withdraw(100 USDC) pays 100 USDC and burns about 101 USDC of shares", async () => {
    // A client's "Payout" shows 100 - 1% = 99 USDC here, and is wrong: withdraw pays the full amount and burns the fee as extra shares.
    const [sharesFor100, sharesBefore, usdcBefore] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "convertToShares",
        args: [amount100Usdc],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
    ]);
    await depositor.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "withdraw",
      args: [amount100Usdc, DEPOSITOR, DEPOSITOR],
    });
    const depositorShares = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    });
    const burned = sharesBefore - depositorShares;

    const depositorUsdc = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    });
    assert.equal(depositorUsdc - usdcBefore, amount100Usdc);
    assert.ok(burned > sharesFor100, `burned ${burned}, 100 USDC is ${sharesFor100} shares`);
    // The fee is 1% of the shares for 100 USDC, so the burned shares are worth about 101 USDC at the price before the call.
    assert.ok(
      burned * 10000n >= sharesFor100 * BURN_LOWER_BPS && burned * 10000n <= sharesFor100 * BURN_UPPER_BPS,
      `burned ${burned}, 100 USDC is ${sharesFor100} shares`,
    );
  });

  it("12 redeem of the whole balance pays assets - assets * fee / 1e18, as a client's Payout says", async () => {
    const [fee, shares] = await Promise.all([
      publicClient.readContract({
        address: withdrawManager,
        abi: withdrawManagerAbi,
        functionName: "getWithdrawFee",
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
    ]);
    const assets = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "convertToAssets",
      args: [shares],
    });
    assert.ok(shares > 0n, `shares: ${shares}`);
    const payout = assets - (assets * fee) / 10n ** FEE_DECIMALS;
    const usdcBefore = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    });
    await depositor.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "redeem",
      args: [shares, DEPOSITOR, DEPOSITOR],
    });
    const depositorUsdc = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    });
    const received = depositorUsdc - usdcBefore;

    // The formula is right for redeem, but not exact here. Step 11 burned about 1 USDC of fee shares, which raised the
    // share price, and redeem first mints the DAO's performance fee (10% in fee package 0) on that rise. So the payout
    // lands below the formula by up to 10% of the burned fee: 0.1 USDC.
    assert.ok(
      received <= payout && payout - received <= parseUnits("0.1", USDC_DECIMALS),
      `received ${received}, Payout formula ${payout}`,
    );
    const depositorShares = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    });
    assert.equal(depositorShares, 0n);
  });
});
