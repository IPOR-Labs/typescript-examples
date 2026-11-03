// S13 Morpho Lend market: install a market for one Morpho Blue market, supply to it through the Alpha,
// accrue interest and exit in full.
// It stands alone: steps 01 and 02 repeat S1's setup in short. The market needs no ERC20 balance market
// and no dependency: it enters and exits in USDC.
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
  type Hex,
} from "viem";
import { accessManagerAbi } from "../abis/access-manager.abi.ts";
import { factoryAbi } from "../abis/factory.abi.ts";
import { morphoSupplyFuseAbi } from "../abis/morpho-supply-fuse.abi.ts";
import { plasmaVaultAbi } from "../abis/plasma-vault.abi.ts";

// Base addresses, from ipor-abi: mainnet/mainnet-base-fusion/addresses.json at 8b1be92 (factory),
// mainnet/addresses.json at e228075 (Morpho supply and balance fuses) and README.md (USDC).
const FACTORY = "0x1455717668fA96534f675856347A973fA907e922";
const MORPHO_SUPPLY_FUSE = "0xae93EF3cf337b9599F0dfC12520c3C281637410F";
const MORPHO_BALANCE_FUSE = "0x7916856E11E0CA021967D0D4daC49D737b7d73d5";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// USDC has 6 decimals.
const USDC_DECIMALS = 6;
const PLASMA_VAULT_NAME = "Story USDC";
const PLASMA_VAULT_SYMBOL = "sUSDC";
const REDEMPTION_DELAY = 0n;
const DAO_FEE_PACKAGE_INDEX = 0n;
// The Morpho Blue market cbBTC/USDC 86% on Base, held by Morpho Blue 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb.
// A Morpho market id is already 32 bytes, so it is the substrate as it is.
const MORPHO_BLUE_MARKET_ID: Hex = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";
// An EOA that holds about 158M USDC at the fork block.
const USDC_WHALE = "0x8da91A6298eA5d1A8Bc985e99798fd0A0f05701a";

// Market IDs from IporFusionMarkets.sol (ipor-fusion 004d054) and role IDs from Roles.sol (ipor-fusion 4fdaf50).
const MORPHO_MARKET = 14n;
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
const BALANCE_UPDATER = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";


const DEPOSIT_SELECTOR = toFunctionSelector("deposit(uint256,address)");
// grantRole: the grant takes effect without an execution delay.
const NO_EXECUTION_DELAY = 0;
const amount10000Usdc = parseUnits("10000", USDC_DECIMALS);
const amount8000Usdc = parseUnits("8000", USDC_DECIMALS);
const amount2000Usdc = parseUnits("2000", USDC_DECIMALS);

const GAS_TOP_UP = parseEther("1");
const ONE_DAY = 24 * 60 * 60;

const { viem, networkHelpers } = await network.create("base");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const fuseManager = await viem.getWalletClient(FUSE_MANAGER);
const alpha = await viem.getWalletClient(ALPHA);
const balanceUpdater = await viem.getWalletClient(BALANCE_UPDATER);

describe("S13 Morpho Lend market on one Morpho Blue market", () => {
  let plasmaVault: Address, accessManager: Address;

  before(async () => {
    // Only the USDC whale needs impersonating: every other account is an unlocked Hardhat default account.
    await networkHelpers.impersonateAccount(USDC_WHALE);
    // Gives the whale ETH to pay gas.
    await networkHelpers.setBalance(USDC_WHALE, GAS_TOP_UP);
  });

  it("01 clones a Plasma Vault and grants its roles, as in S1", async () => {
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
    const [[atomistHadRole], [fuseManagerHadRole], [alphaHadRole], depositRoleBefore] = await Promise.all([
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
      publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "getTargetFunctionRole",
        args: [plasmaVault, DEPOSIT_SELECTOR],
      }),
    ]);
    assert.equal(atomistHadRole, false);
    assert.equal(fuseManagerHadRole, false);
    assert.equal(alphaHadRole, false);
    assert.notEqual(depositRoleBefore, PUBLIC_ROLE);
    // On the access manager: the Owner grants Atomist, then the Atomist grants Fuse Manager and Alpha.
    await owner.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [ATOMIST_ROLE, ATOMIST, NO_EXECUTION_DELAY],
    });
    await atomist.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [FUSE_MANAGER_ROLE, FUSE_MANAGER, NO_EXECUTION_DELAY],
    });
    await atomist.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [ALPHA_ROLE, ALPHA, NO_EXECUTION_DELAY],
    });
    // The Atomist opens deposits to everyone.
    await atomist.writeContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "convertToPublicVault",
    });

    const [[atomistHasRole], [fuseManagerHasRole], [alphaHasRole], depositRole] = await Promise.all([
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
      publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "getTargetFunctionRole",
        args: [plasmaVault, DEPOSIT_SELECTOR],
      }),
    ]);
    assert.equal(atomistHasRole, true);
    assert.equal(fuseManagerHasRole, true);
    assert.equal(alphaHasRole, true);
    assert.equal(depositRole, PUBLIC_ROLE);
  });

  it("02 the whale deposits 10000 USDC", async () => {
    // S3 explains the deposit.
    const whale = await viem.getWalletClient(USDC_WHALE);
    const usdcWhaleAllowanceUsdcBefore = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [USDC_WHALE, plasmaVault],
    });
    assert.equal(usdcWhaleAllowanceUsdcBefore, 0n);
    const idleBefore = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [plasmaVault],
    });
    assert.equal(idleBefore, 0n);
    const usdcWhaleSharesBalance = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "balanceOf",
      args: [USDC_WHALE],
    });
    assert.equal(usdcWhaleSharesBalance, 0n);
    await whale.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "approve",
      args: [plasmaVault, amount10000Usdc],
    });
    const usdcWhaleAllowanceUsdcAfter = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [USDC_WHALE, plasmaVault],
    });
    assert.equal(usdcWhaleAllowanceUsdcAfter, amount10000Usdc);
    await whale.writeContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "deposit",
      args: [amount10000Usdc, USDC_WHALE],
    });

    const idleNow = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [plasmaVault],
    });
    assert.equal(idleNow, amount10000Usdc);
    assert.ok((await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "balanceOf",
      args: [USDC_WHALE],
    })) > 0n);
  });

  it("03 the Fuse Manager installs the Morpho market: supply fuse, balance fuse and the Morpho Blue market id as substrate", async () => {
    // Enter and exit are both (morphoMarketId, amount).
    const [morphoSupplyFuseSupportedBefore, morphoBalanceFuseSupportedBefore] = await Promise.all([
      publicClient.readContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "isFuseSupported",
        args: [MORPHO_SUPPLY_FUSE],
      }),
      publicClient.readContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "isBalanceFuseSupported",
        args: [MORPHO_MARKET, MORPHO_BALANCE_FUSE],
      }),
    ]);
    assert.equal(morphoSupplyFuseSupportedBefore, false);
    assert.equal(morphoBalanceFuseSupportedBefore, false);
    await fuseManager.writeContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "addFuses",
      args: [[MORPHO_SUPPLY_FUSE]],
    });
    await fuseManager.writeContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "addBalanceFuse",
      args: [MORPHO_MARKET, MORPHO_BALANCE_FUSE],
    });
    // Grant the id on market 14 only. Do not also grant it on market 41 (MORPHO_LIQUIDITY_IN_MARKETS):
    // both balance fuses would then count the same position, and total assets would count it twice.
    // grantMarketSubstrates replaces the market's whole list.
    // Oracle requirement: llms.txt requires an oracle price for both tokens of every granted Morpho market, or the market blocks.
    // This story passes without a cbBTC price because MorphoBalanceFuse (ipor-fusion 004d054,
    // contracts/fuses/morpho/MorphoBalanceFuse.sol:142) skips pricing a token whose amount is 0.
    // Anyone can supply cbBTC collateral on the Plasma Vault's behalf. Pricing cbBTC then reverts and blocks execute,
    // withdraw and updateMarketsBalances for market 14, so a real Plasma Vault sets the cbBTC price first.
    const substrateGranted = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "isMarketSubstrateGranted",
      args: [MORPHO_MARKET, MORPHO_BLUE_MARKET_ID],
    });
    assert.equal(substrateGranted, false);
    await fuseManager.writeContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "grantMarketSubstrates",
      args: [MORPHO_MARKET, [MORPHO_BLUE_MARKET_ID]],
    });

    const [
      morphoSupplyFuseSupported,
      morphoBalanceFuseSupported,
      morphoMarketMorphoBlueMarketIdGranted,
    ] = await Promise.all([
      publicClient.readContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "isFuseSupported",
        args: [MORPHO_SUPPLY_FUSE],
      }),
      publicClient.readContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "isBalanceFuseSupported",
        args: [MORPHO_MARKET, MORPHO_BALANCE_FUSE],
      }),
      publicClient.readContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "isMarketSubstrateGranted",
        args: [MORPHO_MARKET, MORPHO_BLUE_MARKET_ID],
      }),
    ]);
    assert.equal(morphoSupplyFuseSupported, true);
    assert.equal(morphoBalanceFuseSupported, true);
    assert.equal(morphoMarketMorphoBlueMarketIdGranted, true);
  });

  it("04 the Alpha supplies 8000 USDC to the Morpho market through execute", async () => {
    const data = encodeFunctionData({
      abi: morphoSupplyFuseAbi,
      functionName: "enter",
      args: [{ morphoMarketId: MORPHO_BLUE_MARKET_ID, amount: amount8000Usdc }],
    });
    const [morphoMarketTotalAssets, plasmaVaultUsdc] = await Promise.all([
      publicClient.readContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "totalAssetsInMarket",
        args: [MORPHO_MARKET],
      }),
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [plasmaVault],
      }),
    ]);
    assert.equal(morphoMarketTotalAssets, 0n);
    assert.equal(plasmaVaultUsdc, amount10000Usdc);
    await alpha.writeContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "execute",
      args: [[{ fuse: MORPHO_SUPPLY_FUSE, data }]],
    });

    // The market reads the position in assets. It differs from the amount entered by rounding of a few wei.
    const [position, idleNow] = await Promise.all([
      publicClient.readContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "totalAssetsInMarket",
        args: [MORPHO_MARKET],
      }),
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [plasmaVault],
      }),
    ]);
    assert.ok(
      position >= amount8000Usdc - 10n && position <= amount8000Usdc + 10n,
      `in market: ${position}`,
    );
    assert.equal(idleNow, amount2000Usdc);
  });

  it("05 a balance updater refreshes the market after a day and total assets grow", async () => {
    // On the access manager: the Atomist grants the role that unlocks updateMarketsBalances on the Plasma Vault, as in S2.
    const [updaterHadRole] = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [UPDATE_MARKETS_BALANCES_ROLE, BALANCE_UPDATER],
    });
    assert.equal(updaterHadRole, false);
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
    await networkHelpers.time.increase(ONE_DAY);
    const totalAssetsBefore = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "totalAssets",
    });
    await balanceUpdater.writeContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "updateMarketsBalances",
      args: [[MORPHO_MARKET]],
    });
    const totalAssetsAfter = await publicClient.readContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "totalAssets",
    });

    assert.ok(totalAssetsAfter > totalAssetsBefore, `one day of interest: ${totalAssetsBefore} -> ${totalAssetsAfter}`);
  });

  it("06 the Alpha exits the market in full and the funds are idle again", async () => {
    // An amount at or above the position exits all of it: reading the position and exiting exactly that can leave a few wei of rounding.
    const data = encodeFunctionData({
      abi: morphoSupplyFuseAbi,
      functionName: "exit",
      args: [{ morphoMarketId: MORPHO_BLUE_MARKET_ID, amount: maxUint256 }],
    });
    const [inMarketBefore, idleBefore] = await Promise.all([
      publicClient.readContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "totalAssetsInMarket",
        args: [MORPHO_MARKET],
      }),
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [plasmaVault],
      }),
    ]);
    assert.ok(inMarketBefore > 0n);
    assert.equal(idleBefore, amount2000Usdc);
    await alpha.writeContract({
      address: plasmaVault,
      abi: plasmaVaultAbi,
      functionName: "execute",
      args: [[{ fuse: MORPHO_SUPPLY_FUSE, data }]],
    });
    const [inMarketNow, idleAfterExit] = await Promise.all([
      publicClient.readContract({
        address: plasmaVault,
        abi: plasmaVaultAbi,
        functionName: "totalAssetsInMarket",
        args: [MORPHO_MARKET],
      }),
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [plasmaVault],
      }),
    ]);
    assert.equal(inMarketNow, 0n);
    assert.ok(idleAfterExit > amount10000Usdc, `idle: ${idleAfterExit}`);
  });
});
