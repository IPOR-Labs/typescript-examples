// S12 ERC-4626 market: install a market for a MetaMorpho USDC vault, supply to it through the Alpha,
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
  pad,
  type Address,
} from "viem";
import { accessManagerAbi } from "../abis/accessManager.abi.ts";
import { erc4626SupplyFuseAbi } from "../abis/erc4626SupplyFuse.abi.ts";
import { factoryAbi } from "../abis/factory.abi.ts";
import { vaultAbi } from "../abis/vault.abi.ts";

// Base addresses, from ipor-abi: mainnet/mainnet-base-fusion/addresses.json at 8b1be92 (factory),
// mainnet/addresses.json at e228075 (ERC-4626 supply and balance fuses) and README.md (USDC).
const FACTORY = "0x1455717668fA96534f675856347A973fA907e922";
const ERC4626_SUPPLY_FUSE = "0xc45d1676514fcB39BC3B9F74a08985242545FAAd";
const ERC4626_BALANCE_FUSE = "0x7F4D9EFdE7EfEBBAFbb506ca3f711764cBc96391";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// USDC has 6 decimals.
const USDC_DECIMALS = 6;
const VAULT_NAME = "Story USDC";
const VAULT_SYMBOL = "sUSDC";
const REDEMPTION_DELAY = 0n;
const DAO_FEE_PACKAGE_INDEX = 0n;
// The target ERC-4626 vault: Steakhouse USDC, a MetaMorpho vault on Base.
const STEAKHOUSE_USDC = "0xbeeF010f9cb27031ad51e3333f9aF9C6B1228183";
// An EOA that holds about 158M USDC at the fork block.
const USDC_WHALE = "0x8da91A6298eA5d1A8Bc985e99798fd0A0f05701a";

// Market IDs from IporFusionMarkets.sol (ipor-fusion 004d054) and role IDs from Roles.sol (ipor-fusion 4fdaf50).
const ERC4626_0001_MARKET = 100001n;
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
const NO_MIN_SHARES_OUT = 0n;
const amount10000Usdc = parseUnits("10000", USDC_DECIMALS);
const amount8000Usdc = parseUnits("8000", USDC_DECIMALS);
const amount2000Usdc = parseUnits("2000", USDC_DECIMALS);

const { viem, networkHelpers } = await network.create("base");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const fuseManager = await viem.getWalletClient(FUSE_MANAGER);
const alpha = await viem.getWalletClient(ALPHA);
const balanceUpdater = await viem.getWalletClient(BALANCE_UPDATER);

describe("S12 ERC-4626 market on a MetaMorpho USDC vault", () => {
  let vault: Address, accessManager: Address;

  before(async () => {
    // Only the USDC whale needs impersonating: every other account is an unlocked Hardhat default account.
    await networkHelpers.impersonateAccount(USDC_WHALE);
    // Gives the whale ETH to pay gas.
    await networkHelpers.setBalance(USDC_WHALE, parseEther("1"));
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
        args: [vault, DEPOSIT_SELECTOR],
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
      address: vault,
      abi: vaultAbi,
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
        args: [vault, DEPOSIT_SELECTOR],
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
    assert.equal(await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [USDC_WHALE, vault],
    }), 0n);
    const idleBefore = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [vault],
    });
    assert.equal(idleBefore, 0n);
    assert.equal(await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "balanceOf",
      args: [USDC_WHALE],
    }), 0n);
    await whale.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "approve",
      args: [vault, amount10000Usdc],
    });
    assert.equal(await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [USDC_WHALE, vault],
    }), amount10000Usdc);
    await whale.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "deposit",
      args: [amount10000Usdc, USDC_WHALE],
    });

    const idleNow = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [vault],
    });
    assert.equal(idleNow, amount10000Usdc);
    assert.ok((await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "balanceOf",
      args: [USDC_WHALE],
    })) > 0n);
  });

  it("03 the Fuse Manager installs the ERC-4626 market: supply fuse, balance fuse and the target vault as substrate", async () => {
    // Use the 3-field supply fuse above. The legacy 2-field ERC-4626 supply fuse 0xbe8ab5217F4f251E4A667650fc34a63035C231a8
    // is also active on the FuseWhitelist for this market, and it fails on the 3-field enter (vault, vaultAssetAmount, minSharesOut).
    // The exit struct is (vault, vaultAssetAmount, maxSharesBurned).
    const [erc4626SupplyFuseSupportedBefore, erc4626BalanceFuseSupportedBefore] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "isFuseSupported",
        args: [ERC4626_SUPPLY_FUSE],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "isBalanceFuseSupported",
        args: [ERC4626_0001_MARKET, ERC4626_BALANCE_FUSE],
      }),
    ]);
    assert.equal(erc4626SupplyFuseSupportedBefore, false);
    assert.equal(erc4626BalanceFuseSupportedBefore, false);
    await fuseManager.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "addFuses",
      args: [[ERC4626_SUPPLY_FUSE]],
    });
    await fuseManager.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "addBalanceFuse",
      args: [ERC4626_0001_MARKET, ERC4626_BALANCE_FUSE],
    });
    // The substrate is the target vault's address, left-padded to 32 bytes. grantMarketSubstrates replaces the market's whole list.
    const substrate = pad(STEAKHOUSE_USDC, { size: 32 });
    assert.equal(await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "isMarketSubstrateGranted",
      args: [ERC4626_0001_MARKET, substrate],
    }), false);
    await fuseManager.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "grantMarketSubstrates",
      args: [ERC4626_0001_MARKET, [substrate]],
    });

    const [
      erc4626SupplyFuseSupported,
      erc4626BalanceFuseSupported,
      erc46260001MarketSubstrateGranted,
    ] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "isFuseSupported",
        args: [ERC4626_SUPPLY_FUSE],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "isBalanceFuseSupported",
        args: [ERC4626_0001_MARKET, ERC4626_BALANCE_FUSE],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "isMarketSubstrateGranted",
        args: [ERC4626_0001_MARKET, substrate],
      }),
    ]);
    assert.equal(erc4626SupplyFuseSupported, true);
    assert.equal(erc4626BalanceFuseSupported, true);
    assert.equal(erc46260001MarketSubstrateGranted, true);
  });

  it("04 the Alpha supplies 8000 USDC to the target vault through execute", async () => {
    // minSharesOut 0: this story does not guard against share price slippage. A real Alpha sets it.
    const data = encodeFunctionData({
      abi: erc4626SupplyFuseAbi,
      functionName: "enter",
      args: [{ vault: STEAKHOUSE_USDC, vaultAssetAmount: amount8000Usdc, minSharesOut: NO_MIN_SHARES_OUT }],
    });
    const [erc46260001MarketTotalAssets, vaultUsdc] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "totalAssetsInMarket",
        args: [ERC4626_0001_MARKET],
      }),
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vault],
      }),
    ]);
    assert.equal(erc46260001MarketTotalAssets, 0n);
    assert.equal(vaultUsdc, amount10000Usdc);
    await alpha.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "execute",
      args: [[{ fuse: ERC4626_SUPPLY_FUSE, data }]],
    });

    // The market reads the position in assets. It differs from the amount entered by rounding of a few wei.
    const [position, idleNow] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "totalAssetsInMarket",
        args: [ERC4626_0001_MARKET],
      }),
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vault],
      }),
    ]);
    assert.ok(
      position >= amount8000Usdc - 10n && position <= amount8000Usdc + 10n,
      `in market: ${position}`,
    );
    assert.equal(idleNow, amount2000Usdc);
  });

  it("05 a balance updater refreshes the market after a day and total assets grow", async () => {
    // On the access manager: the Atomist grants the role that unlocks updateMarketsBalances on the vault, as in S2.
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
    await networkHelpers.time.increase(24 * 60 * 60);
    const totalAssetsBefore = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "totalAssets",
    });
    await balanceUpdater.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "updateMarketsBalances",
      args: [[ERC4626_0001_MARKET]],
    });
    const totalAssetsAfter = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "totalAssets",
    });

    assert.ok(totalAssetsAfter > totalAssetsBefore, `one day of interest: ${totalAssetsBefore} -> ${totalAssetsAfter}`);
  });

  it("06 the Alpha exits the market in full and the funds are idle again", async () => {
    // Erc4626SupplyFuse redeems at most the cap when the amount is at least maxWithdraw (ipor-fusion 004d054), so maxUint256 is a full exit. maxSharesBurned is the most shares the exit may burn.
    const data = encodeFunctionData({
      abi: erc4626SupplyFuseAbi,
      functionName: "exit",
      args: [{ vault: STEAKHOUSE_USDC, vaultAssetAmount: maxUint256, maxSharesBurned: maxUint256 }],
    });
    const [inMarketBefore, idleBefore] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "totalAssetsInMarket",
        args: [ERC4626_0001_MARKET],
      }),
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vault],
      }),
    ]);
    assert.ok(inMarketBefore > 0n);
    assert.equal(idleBefore, amount2000Usdc);
    await alpha.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "execute",
      args: [[{ fuse: ERC4626_SUPPLY_FUSE, data }]],
    });
    const [inMarketNow, idleAfterExit] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "totalAssetsInMarket",
        args: [ERC4626_0001_MARKET],
      }),
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vault],
      }),
    ]);
    assert.equal(inMarketNow, 0n);
    assert.ok(idleAfterExit > amount10000Usdc, `idle: ${idleAfterExit}`);
  });
});
