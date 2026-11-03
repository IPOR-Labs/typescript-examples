// S7 Alpha cycle: the Alpha moves vault funds into Aave V3 and back with execute, and a balance updater
// refreshes the stored market balance after time passes.
// It follows S1: steps 01 and 02 repeat S1's setup in short, then a depositor funds the vault.
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
  pad,
  toFunctionSelector,
  zeroAddress,
  type Address,
} from "viem";
import { aaveV3SupplyFuseAbi } from "../abis/aaveV3SupplyFuse.abi.ts";
import { accessManagerAbi } from "../abis/accessManager.abi.ts";
import { factoryAbi } from "../abis/factory.abi.ts";
import { vaultAbi } from "../abis/vault.abi.ts";

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
// Aave V3 aBasUSDC, the aToken the vault holds after enter. Not listed in ipor-abi: from the Aave address book (bgd-labs/aave-address-book, AaveV3Base), checked on Base through UNDERLYING_ASSET_ADDRESS() (USDC) and POOL() (the Aave V3 Pool).
const AAVE_USDC = "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB";
// An EOA that holds enough USDC on Base at the fork block to fund the depositor.
const USDC_WHALE = "0x8da91A6298eA5d1A8Bc985e99798fd0A0f05701a";

// Market IDs from IporFusionMarkets.sol (ipor-fusion 004d054) and role IDs from Roles.sol (ipor-fusion 4fdaf50).
const AAVE_V3_MARKET = 1n;
const ERC20_VAULT_BALANCE_MARKET = 7n;
const ATOMIST_ROLE = 100n;
const ALPHA_ROLE = 200n;
const FUSE_MANAGER_ROLE = 300n;
const UPDATE_MARKETS_BALANCES_ROLE = 1000n;
const PUBLIC_ROLE = 2n ** 64n - 1n;

// Hardhat's default accounts, one per role.
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ATOMIST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const FUSE_MANAGER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ALPHA = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const DEPOSITOR = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const BALANCE_UPDATER = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";


// grantRole: the grant takes effect without an execution delay.
const NO_EXECUTION_DELAY = 0;
const DEPOSIT_SELECTOR = toFunctionSelector("deposit(uint256,address)");
// Aave eMode category 0 is no eMode.
const E_MODE_NONE = 0n;
const amount1000Usdc = parseUnits("1000", USDC_DECIMALS);
const amount300Usdc = parseUnits("300", USDC_DECIMALS);

const { viem, networkHelpers } = await network.create("base");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const fuseManager = await viem.getWalletClient(FUSE_MANAGER);
const alpha = await viem.getWalletClient(ALPHA);
const depositor = await viem.getWalletClient(DEPOSITOR);
const balanceUpdater = await viem.getWalletClient(BALANCE_UPDATER);

describe("S7 Alpha cycle on Aave V3", () => {
  let vault: Address, accessManager: Address;
  let totalAssetsBefore: bigint, storedBefore: bigint;

  before(async () => {
    // Only the USDC whale needs impersonating: every other account is an unlocked Hardhat default account.
    await networkHelpers.impersonateAccount(USDC_WHALE);
    // Gives the whale ETH to pay gas for its USDC transfer.
    await networkHelpers.setBalance(USDC_WHALE, parseEther("1"));
    const whale = await viem.getWalletClient(USDC_WHALE);
    await whale.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "transfer",
      args: [DEPOSITOR, amount1000Usdc],
    });
  });

  it("01 clones a vault and grants its roles, as in S1", async () => {
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

    assert.notEqual(vault, zeroAddress);
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

  it("03 a depositor deposits 1000 USDC", async () => {
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
    const allowanceAfter = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [DEPOSITOR, vault],
    });
    assert.equal(allowanceAfter, amount1000Usdc);

    const [idleBefore, sharesBefore] = await Promise.all([
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vault],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
    ]);
    assert.equal(idleBefore, 0n);
    assert.equal(sharesBefore, 0n);
    await depositor.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "deposit",
      args: [amount1000Usdc, DEPOSITOR],
    });

    const [idleNow, inAaveNow, sharesAfter] = await Promise.all([
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
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
    ]);
    assert.equal(idleNow, amount1000Usdc);
    assert.equal(inAaveNow, 0n);
    assert.ok(sharesAfter > 0n, `shares: ${sharesAfter}`);
  });

  it("04 the depositor cannot execute: only the Alpha may move funds", async () => {
    // A FuseAction is the fuse address and the ABI-encoded call of its enter or exit function.
    const enterAction = {
      fuse: AAVE_V3_SUPPLY_FUSE as Address,
      data: encodeFunctionData({
        abi: aaveV3SupplyFuseAbi,
        functionName: "enter",
        args: [{ asset: USDC, amount: amount300Usdc, userEModeCategoryId: E_MODE_NONE }],
      }),
    };
    await assert.rejects(
      // Expected to revert: execute is restricted to ALPHA_ROLE.
      depositor.writeContract({
        address: vault,
        abi: vaultAbi,
        functionName: "execute",
        args: [[enterAction]],
      }),
      /AccessManagedUnauthorized/,
    );
  });

  it("05 the Alpha enters Aave V3 with 300 USDC", async () => {
    // A FuseAction is the fuse address and the ABI-encoded call of its enter or exit function.
    const enterAction = {
      fuse: AAVE_V3_SUPPLY_FUSE as Address,
      data: encodeFunctionData({
        abi: aaveV3SupplyFuseAbi,
        functionName: "enter",
        args: [{ asset: USDC, amount: amount300Usdc, userEModeCategoryId: E_MODE_NONE }],
      }),
    };
    const [idleBefore, inAaveBefore] = await Promise.all([
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
    assert.equal(inAaveBefore, 0n);
    await alpha.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "execute",
      args: [[enterAction]],
    });

    const idleNow = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [vault],
    });
    assert.equal(idleNow, idleBefore - amount300Usdc);
    // Aave rounds the aToken balance down by at most a unit or two.
    const inAaveNow = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "totalAssetsInMarket",
      args: [AAVE_V3_MARKET],
    });
    assert.ok(inAaveNow >= amount300Usdc - 2n, `in Aave: ${inAaveNow}`);
  });

  it("06 the Atomist grants a balance updater, then 30 days later the stored market balance is stale", async () => {
    const [updaterHadRole] = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [UPDATE_MARKETS_BALANCES_ROLE, BALANCE_UPDATER],
    });
    assert.equal(updaterHadRole, false);
    // On the access manager: the Atomist grants the role that unlocks updateMarketsBalances on the vault.
    await atomist.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [UPDATE_MARKETS_BALANCES_ROLE, BALANCE_UPDATER, NO_EXECUTION_DELAY],
    });
    const [updaterHasRole] = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [UPDATE_MARKETS_BALANCES_ROLE, BALANCE_UPDATER],
    });
    assert.equal(updaterHasRole, true);
    storedBefore = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "totalAssetsInMarket",
      args: [AAVE_V3_MARKET],
    });
    totalAssetsBefore = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "totalAssets",
    });
    await networkHelpers.time.increase(30 * 24 * 60 * 60);

    // Aave pays interest into the aToken balance, but the vault stores the market balance until it is refreshed.
    const [inAaveNow, totalAssetsNow] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "totalAssetsInMarket",
        args: [AAVE_V3_MARKET],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "totalAssets",
      }),
    ]);
    assert.equal(inAaveNow, storedBefore);
    assert.equal(totalAssetsNow, totalAssetsBefore);
    // The chain moved on: the vault's live aUSDC balance is already above the stored market balance.
    const liveAave = await publicClient.readContract({
      address: AAVE_USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [vault],
    });
    assert.ok(liveAave > storedBefore, `live aUSDC ${liveAave} vs stored ${storedBefore}`);
  });

  it("07 the balance updater refreshes the Aave V3 market and total assets grow", async () => {
    const inAaveBeforeRefresh = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "totalAssetsInMarket",
      args: [AAVE_V3_MARKET],
    });
    assert.equal(inAaveBeforeRefresh, storedBefore);
    await balanceUpdater.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "updateMarketsBalances",
      args: [[AAVE_V3_MARKET]],
    });

    // Fresh balances in one round trip: a single multicall reads every market, like ipor-webapp does per market.
    // Pattern: peers/ipor-webapp/packages/fusion-sdk/src/markets/aave-v3/read-aave-pool-balances.ts (read-aave-pool-balances)
    const [totalAssetsAfter, inAaveAfter, inErc20After] = await publicClient.multicall({
      allowFailure: false,
      contracts: [
        { address: vault, abi: vaultAbi, functionName: "totalAssets" },
        { address: vault, abi: vaultAbi, functionName: "totalAssetsInMarket", args: [AAVE_V3_MARKET] },
        { address: vault, abi: vaultAbi, functionName: "totalAssetsInMarket", args: [ERC20_VAULT_BALANCE_MARKET] },
      ],
    });
    // Only the refreshed market moved: the idle USDC market is not part of this refresh.
    assert.equal(inErc20After, 0n);
    assert.ok(
      totalAssetsAfter > totalAssetsBefore,
      `30 days of Aave V3 interest: ${totalAssetsBefore} -> ${totalAssetsAfter}`,
    );
    assert.ok(inAaveAfter > storedBefore, `in Aave: ${inAaveAfter}`);
  });

  it("08 the Alpha exits everything with the maximum amount", async () => {
    // The fuse exits min(aToken balance, amount), so type(uint256).max unwinds the whole position, interest included.
    // The story supplies 300 and not more on purpose: at the fork block the Aave V3 USDC reserve has almost no free liquidity
    // beyond what the vault supplies, so a withdraw above supply + ~2 USDC fails, and the fuse swallows that failure (AaveV3SupplyFuseExitFailed).
    const exitAction = {
      fuse: AAVE_V3_SUPPLY_FUSE as Address,
      data: encodeFunctionData({
        abi: aaveV3SupplyFuseAbi,
        functionName: "exit",
        args: [{ asset: USDC, amount: maxUint256 }],
      }),
    };
    const [idleBeforeExit, inAaveBeforeExit] = await Promise.all([
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
    assert.ok(inAaveBeforeExit > amount300Usdc - 2n, `in Aave: ${inAaveBeforeExit}`);
    await alpha.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "execute",
      args: [[exitAction]],
    });

    const [idleAfter, inAaveNow] = await Promise.all([
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
    assert.ok(idleAfter > amount1000Usdc, `idle: ${idleAfter}`);
    assert.ok(
      idleAfter >= idleBeforeExit + inAaveBeforeExit,
      `idle ${idleAfter} vs ${idleBeforeExit} + ${inAaveBeforeExit}`,
    );
    assert.equal(inAaveNow, 0n);
  });
});
