// S9 Scheduled withdraw: when every dollar sits in a market, a depositor requests a withdrawal,
// the Alpha frees the funds and releases them, and the depositor redeems from the request
// inside its window. Then a partial release, a request that overwrites another, and expiry.
// It follows S1: steps 01 and 02 repeat S1's setup in short, then two depositors fund the vault.
// Every step is a real transaction on a Base fork, and a step depends on the steps above it.
// The story skips simulation on purpose, to show the transaction flow. A real app on a real
// chain should simulate before each transaction, to check gas usage and whether it reverts.
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
// An EOA that holds enough USDC on Base at the fork block to fund both depositors.
const USDC_WHALE = "0x8da91A6298eA5d1A8Bc985e99798fd0A0f05701a";
// The vault keeps its Withdraw Manager's address in this storage slot and has no getter for it
// (PlasmaVaultStorageLib.sol:722, ipor-fusion 004d054). The factory's event does not carry it either.
const WITHDRAW_MANAGER_SLOT = "0x465d2ff0062318fe6f4c7e9ac78cfcd70bc86a1d992722875ef83a9770513100";

// Market IDs from IporFusionMarkets.sol (ipor-fusion 004d054) and role IDs from Roles.sol (ipor-fusion 4fdaf50).
const AAVE_V3_MARKET = 1n;
const ERC20_VAULT_BALANCE_MARKET = 7n;
const ATOMIST_ROLE = 100n;
const ALPHA_ROLE = 200n;
const FUSE_MANAGER_ROLE = 300n;
const WITHDRAW_MANAGER_REQUEST_FEE_ROLE = 901n;
const PUBLIC_ROLE = 2n ** 64n - 1n;

// Hardhat's default accounts, one per role.
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ATOMIST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const FUSE_MANAGER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ALPHA = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const DEPOSITOR_A = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const DEPOSITOR_B = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";


// grantRole: the grant takes effect without an execution delay.
const NO_EXECUTION_DELAY = 0;
const DEPOSIT_SELECTOR = toFunctionSelector("deposit(uint256,address)");
// Aave eMode category 0 is no eMode.
const E_MODE_NONE = 0n;
// Fees have 18 decimals: 1e16 is 1%.
const feeOnePercent = parseEther("0.01");
// Fees have 18 decimals.
const FEE_DECIMALS = 18n;
const ONE_SECOND = 1n;
const amount1000Usdc = parseUnits("1000", USDC_DECIMALS);
const amount2000Usdc = parseUnits("2000", USDC_DECIMALS);
const amount100Usdc = parseUnits("100", USDC_DECIMALS);
const amount400Usdc = parseUnits("400", USDC_DECIMALS);
const amount4Usdc = parseUnits("4", USDC_DECIMALS);
const amount500Usdc = parseUnits("500", USDC_DECIMALS);
const amount200Usdc = parseUnits("200", USDC_DECIMALS);
const amount300Usdc = parseUnits("300", USDC_DECIMALS);

const { viem, networkHelpers } = await network.create("base");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const fuseManager = await viem.getWalletClient(FUSE_MANAGER);
const alpha = await viem.getWalletClient(ALPHA);
const depositorA = await viem.getWalletClient(DEPOSITOR_A);
const depositorB = await viem.getWalletClient(DEPOSITOR_B);

describe("S9 Scheduled withdraw from a USDC vault on Aave V3", () => {
  let vault: Address, accessManager: Address, withdrawManager: Address;
  let lockEnd: bigint, requestFee: bigint;

  before(async () => {
    // Only the USDC whale needs impersonating: every other account is an unlocked Hardhat default account.
    await networkHelpers.impersonateAccount(USDC_WHALE);
    // Gives the whale ETH to pay gas for its USDC transfers.
    await networkHelpers.setBalance(USDC_WHALE, parseEther("1"));
    const whale = await viem.getWalletClient(USDC_WHALE);
    for (const depositor of [DEPOSITOR_A, DEPOSITOR_B] as const) {
      await whale.writeContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "transfer",
        args: [depositor, amount1000Usdc],
      });
    }
  });

  it("01 clones a vault, reads its Withdraw Manager and grants its roles, as in S1", async () => {
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
    // The slot holds the address left-padded to 32 bytes, so its last 20 bytes are the address.
    const slot = await publicClient.getStorageAt({ address: vault, slot: WITHDRAW_MANAGER_SLOT });
    assert.ok(slot && slot !== zeroHash, "the vault has no Withdraw Manager");
    withdrawManager = getAddress(slice(slot, 12));
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
    // On the access manager: Alpha unlocks execute on the vault and releaseFunds on the Withdraw Manager.
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

  it("03 A and B deposit 1000 USDC each and the Alpha supplies all idle funds to Aave V3", async () => {
    // S3 explains the deposit, S7 the Alpha's execute call.
    for (const depositor of [depositorA, depositorB]) {
      const allowanceBefore = await publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "allowance",
        args: [depositor.account.address, vault],
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
        args: [depositor.account.address, vault],
      });
      assert.equal(allowanceAfter, amount1000Usdc);
      const sharesBefore = await publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [depositor.account.address],
      });
      assert.equal(sharesBefore, 0n);
      await depositor.writeContract({
        address: vault,
        abi: vaultAbi,
        functionName: "deposit",
        args: [amount1000Usdc, depositor.account.address],
      });
      const sharesAfter = await publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [depositor.account.address],
      });
      assert.ok(sharesAfter > 0n, `shares: ${sharesAfter}`);
    }
    const [idle, inAaveBefore] = await Promise.all([
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
    const data = encodeFunctionData({
      abi: aaveV3SupplyFuseAbi,
      functionName: "enter",
      args: [{ asset: USDC, amount: idle, userEModeCategoryId: E_MODE_NONE }],
    });
    await alpha.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "execute",
      args: [[{ fuse: AAVE_V3_SUPPLY_FUSE, data }]],
    });

    assert.equal(idle, amount2000Usdc);
    const vaultUsdc = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [vault],
    });
    assert.equal(vaultUsdc, 0n);
    // Aave rounds the aToken balance down by at most a unit or two.
    const inAaveAfter = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "totalAssetsInMarket",
      args: [AAVE_V3_MARKET],
    });
    assert.ok(inAaveAfter >= amount2000Usdc - 2n, `in Aave: ${inAaveAfter}`);
  });

  it("04 a plain withdraw reverts: nothing is idle and no instant-withdrawal fuse can unwind Aave", async () => {
    // This is why the scheduled path exists. A client picks it when the amount is above max instant (S8).
    await assert.rejects(
      depositorA.writeContract({
        address: vault,
        abi: vaultAbi,
        functionName: "withdraw",
        args: [amount100Usdc, DEPOSITOR_A, DEPOSITOR_A],
      }),
      /ERC20: transfer amount exceeds balance/,
    );
  });

  it("05 reads the Scheduled values: withdraw window, lock end, and the request fee once the Atomist sets one", async () => {
    const [window, [atomistHadRole901]] = await Promise.all([
      publicClient.readContract({
        address: withdrawManager,
        abi: withdrawManagerAbi,
        functionName: "getWithdrawWindow",
      }),
      publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "hasRole",
        args: [WITHDRAW_MANAGER_REQUEST_FEE_ROLE, ATOMIST],
      }),
    ]);
    assert.equal(atomistHadRole901, false);
    // On the access manager: role 901 unlocks updateRequestFee on the Withdraw Manager. The Atomist administers it.
    await atomist.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [WITHDRAW_MANAGER_REQUEST_FEE_ROLE, ATOMIST, NO_EXECUTION_DELAY],
    });
    const [[atomistHasRole901], requestFeeBefore] = await Promise.all([
      publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "hasRole",
        args: [WITHDRAW_MANAGER_REQUEST_FEE_ROLE, ATOMIST],
      }),
      publicClient.readContract({
        address: withdrawManager,
        abi: withdrawManagerAbi,
        functionName: "getRequestFee",
      }),
    ]);
    assert.equal(atomistHasRole901, true);
    assert.equal(requestFeeBefore, 0n);
    await atomist.writeContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "updateRequestFee",
      args: [feeOnePercent],
    });
    // "Off-boarding (x%)": the request fee, shown as amount * fee / 1e18.
    requestFee = await publicClient.readContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "getRequestFee",
    });
    // "… withdraw it by": a client adds the window to its clock. Here the clock is the chain's.
    const block = await publicClient.getBlock();
    lockEnd = block.timestamp + window;

    assert.equal(window, 86400n);
    assert.equal(requestFee, parseEther("0.01"));
    assert.equal((amount400Usdc * requestFee) / 10n ** FEE_DECIMALS, amount4Usdc);
  });

  it("06 A requests 400 USDC: the fee is taken up front, the shares stay with A, nothing is redeemable yet", async () => {
    const shares = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "convertToShares",
      args: [amount400Usdc],
    });
    const fee = (shares * requestFee) / 10n ** FEE_DECIMALS;
    const [balanceBefore, requestBefore] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [DEPOSITOR_A],
      }),
      publicClient.readContract({
        address: withdrawManager,
        abi: withdrawManagerAbi,
        functionName: "requestInfo",
        args: [DEPOSITOR_A],
      }),
    ]);
    assert.equal(requestBefore.shares, 0n);
    await depositorA.writeContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "requestShares",
      args: [shares],
    });
    const request = await publicClient.readContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "requestInfo",
      args: [DEPOSITOR_A],
    });

    // The request records the shares minus the fee. The fee shares move to the Withdraw Manager.
    assert.equal(request.shares, shares - fee);
    // A request does not lock shares: A still holds every share but the fee.
    const [depositorAShares, block] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [DEPOSITOR_A],
      }),
      publicClient.getBlock(),
    ]);
    assert.equal(depositorAShares, balanceBefore - fee);
    assert.equal(request.endWithdrawWindowTimestamp - request.withdrawWindowInSeconds, block.timestamp);
    assert.ok(request.endWithdrawWindowTimestamp >= lockEnd);
    assert.equal(request.canWithdraw, false);
  });

  it("07 the Alpha exits 400 USDC from Aave and releases A's request", async () => {
    const { shares } = await publicClient.readContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "requestInfo",
      args: [DEPOSITOR_A],
    });
    const exitData = encodeFunctionData({
      abi: aaveV3SupplyFuseAbi,
      functionName: "exit",
      args: [{ asset: USDC, amount: amount400Usdc }],
    });
    const idleBeforeExit = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [vault],
    });
    assert.equal(idleBeforeExit, 0n);
    await alpha.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "execute",
      args: [[{ fuse: AAVE_V3_SUPPLY_FUSE, data: exitData }]],
    });
    const idleAfterExit = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [vault],
    });
    assert.equal(idleAfterExit, amount400Usdc);
    // releaseFunds overwrites the released total, it does not add to it: the value passed is the new total released, including shares
    // released earlier and not yet redeemed. The timestamp must be in the past, so the story waits 1 s first.
    const releaseRequest = await publicClient.readContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "requestInfo",
      args: [DEPOSITOR_A],
    });
    const releaseRequestTimestamp = releaseRequest.endWithdrawWindowTimestamp - releaseRequest.withdrawWindowInSeconds;
    const sharesToRelease = await publicClient.readContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "getSharesToRelease",
    });
    const releaseTotal = sharesToRelease + shares;
    assert.equal(sharesToRelease, 0n);
    assert.equal(releaseRequest.canWithdraw, false);
    await networkHelpers.time.increase(1);
    await alpha.writeContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "releaseFunds",
      args: [releaseRequestTimestamp + ONE_SECOND, releaseTotal],
    });

    const [sharesToRelease2, depositorARequest] = await Promise.all([
      publicClient.readContract({
        address: withdrawManager,
        abi: withdrawManagerAbi,
        functionName: "getSharesToRelease",
      }),
      publicClient.readContract({
        address: withdrawManager,
        abi: withdrawManagerAbi,
        functionName: "requestInfo",
        args: [DEPOSITOR_A],
      }),
    ]);
    assert.equal(sharesToRelease2, shares);
    assert.equal(depositorARequest.canWithdraw, true);
  });

  it("08 A redeems from the request and receives the USDC", async () => {
    const { shares } = await publicClient.readContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "requestInfo",
      args: [DEPOSITOR_A],
    });
    // "Requested amount": the request's shares in assets.
    const [expected, usdcBefore] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "convertToAssets",
        args: [shares],
      }),
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [DEPOSITOR_A],
      }),
    ]);
    assert.ok(shares > 0n, `request shares: ${shares}`);
    await depositorA.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "redeemFromRequest",
      args: [shares, DEPOSITOR_A, DEPOSITOR_A],
    });
    const depositorAUsdc = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [DEPOSITOR_A],
    });
    const received = depositorAUsdc - usdcBefore;

    // Management fee accrual pays slightly under convertToAssets (0.011% measured at 1%).
    const [depositorARequest, sharesToRelease] = await Promise.all([
      publicClient.readContract({
        address: withdrawManager,
        abi: withdrawManagerAbi,
        functionName: "requestInfo",
        args: [DEPOSITOR_A],
      }),
      publicClient.readContract({
        address: withdrawManager,
        abi: withdrawManagerAbi,
        functionName: "getSharesToRelease",
      }),
    ]);
    assert.ok(
      received <= expected && received >= (expected * 9990n) / 10000n,
      `received ${received}, expected about ${expected}`,
    );
    assert.equal(depositorARequest.shares, 0n);
    assert.equal(sharesToRelease, 0n);
  });

  it("09 B requests 500 USDC, the Alpha releases only 200, and B redeems what is available", async () => {
    const [sharesAmount, depositorBRequestBefore] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "convertToShares",
        args: [amount500Usdc],
      }),
      publicClient.readContract({
        address: withdrawManager,
        abi: withdrawManagerAbi,
        functionName: "requestInfo",
        args: [DEPOSITOR_B],
      }),
    ]);
    assert.equal(depositorBRequestBefore.shares, 0n);
    await depositorB.writeContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "requestShares",
      args: [sharesAmount],
    });
    const depositorBRequestAfter = await publicClient.readContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "requestInfo",
      args: [DEPOSITOR_B],
    });
    assert.ok(depositorBRequestAfter.shares > 0n, `request shares: ${depositorBRequestAfter.shares}`);
    const exitData = encodeFunctionData({
      abi: aaveV3SupplyFuseAbi,
      functionName: "exit",
      args: [{ asset: USDC, amount: amount200Usdc }],
    });
    const idleBeforeExit = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [vault],
    });
    await alpha.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "execute",
      args: [[{ fuse: AAVE_V3_SUPPLY_FUSE, data: exitData }]],
    });
    const [idleAfterExit, sharesAmount2] = await Promise.all([
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vault],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "convertToShares",
        args: [amount200Usdc],
      }),
    ]);
    assert.equal(idleAfterExit - idleBeforeExit, amount200Usdc);
    // releaseFunds overwrites the released total, it does not add to it: the value passed is the new total released, including shares
    // released earlier and not yet redeemed. The timestamp must be in the past, so the story waits 1 s first.
    const releaseRequest = await publicClient.readContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "requestInfo",
      args: [DEPOSITOR_B],
    });
    const releaseRequestTimestamp = releaseRequest.endWithdrawWindowTimestamp - releaseRequest.withdrawWindowInSeconds;
    const sharesToRelease = await publicClient.readContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "getSharesToRelease",
    });
    const releaseTotal = sharesToRelease + sharesAmount2;
    assert.equal(releaseRequest.canWithdraw, false);
    await networkHelpers.time.increase(1);
    await alpha.writeContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "releaseFunds",
      args: [releaseRequestTimestamp + ONE_SECOND, releaseTotal],
    });

    const depositorBRequest = await publicClient.readContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "requestInfo",
      args: [DEPOSITOR_B],
    });
    const requested = depositorBRequest.shares;
    // "Available to redeem": the shares the release covers, capped by the request and B's balance.
    const [balance, released] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [DEPOSITOR_B],
      }),
      publicClient.readContract({
        address: withdrawManager,
        abi: withdrawManagerAbi,
        functionName: "getSharesToRelease",
      }),
    ]);
    const lowerOfRequestedAndReleased = requested < released ? requested : released;
    const coverable = balance < lowerOfRequestedAndReleased ? balance : lowerOfRequestedAndReleased;
    assert.ok(coverable > 0n && coverable < requested, `coverable ${coverable} of ${requested}`);

    const usdcBefore = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [DEPOSITOR_B],
    });
    await depositorB.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "redeemFromRequest",
      args: [coverable, DEPOSITOR_B, DEPOSITOR_B],
    });
    const depositorBUsdc = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [DEPOSITOR_B],
    });
    const received = depositorBUsdc - usdcBefore;

    assert.ok(
      received <= amount200Usdc && received >= parseUnits("199.9", USDC_DECIMALS),
      `received ${received}`,
    );
    // The rest of the request stays open until the Alpha releases more.
    const depositorBRequest2 = await publicClient.readContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "requestInfo",
      args: [DEPOSITOR_B],
    });
    assert.equal(depositorBRequest2.shares, requested - coverable);
  });

  it("10 B requests again inside the window: the new request replaces the old one and the fee paid is not refunded", async () => {
    // A client warns before "Update Withdrawal": the remaining request is dropped, not added to.
    const [requestBefore, shares] = await Promise.all([
      publicClient.readContract({
        address: withdrawManager,
        abi: withdrawManagerAbi,
        functionName: "requestInfo",
        args: [DEPOSITOR_B],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "convertToShares",
        args: [amount300Usdc],
      }),
    ]);
    const fee = (shares * requestFee) / 10n ** FEE_DECIMALS;
    const [balanceBefore, feesHeldBefore] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [DEPOSITOR_B],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [withdrawManager],
      }),
    ]);
    await depositorB.writeContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "requestShares",
      args: [shares],
    });
    const after = await publicClient.readContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "requestInfo",
      args: [DEPOSITOR_B],
    });

    assert.ok(requestBefore.shares > 0n && after.endWithdrawWindowTimestamp > requestBefore.endWithdrawWindowTimestamp);
    assert.equal(after.shares, shares - fee);
    // B pays the new fee in full and gets nothing of the first fee back: the Withdraw Manager keeps both.
    const [depositorBShares, withdrawManagerShares] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [DEPOSITOR_B],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [withdrawManager],
      }),
    ]);
    assert.equal(depositorBShares, balanceBefore - fee);
    assert.equal(withdrawManagerShares, feesHeldBefore + fee);
    // The new request is newer than the last release, so it waits for its own.
    assert.equal(after.canWithdraw, false);
  });

  it("11 after the window ends, the request has expired and redeeming from it reverts", async () => {
    const { shares, endWithdrawWindowTimestamp } = await publicClient.readContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "requestInfo",
      args: [DEPOSITOR_B],
    });
    // Released, so the only thing that stops B below is the window.
    // This release is unbacked on purpose: the vault holds only a few USDC idle, and it is released only so the later
    // revert proves expiry. A real Alpha exits from Aave first, as steps 07 and 09 do.
    // releaseFunds overwrites the released total, it does not add to it: the value passed is the new total released, including shares
    // released earlier and not yet redeemed. The timestamp must be in the past, so the story waits 1 s first.
    const releaseRequest = await publicClient.readContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "requestInfo",
      args: [DEPOSITOR_B],
    });
    const releaseRequestTimestamp = releaseRequest.endWithdrawWindowTimestamp - releaseRequest.withdrawWindowInSeconds;
    const sharesToRelease = await publicClient.readContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "getSharesToRelease",
    });
    const releaseTotal = sharesToRelease + shares;
    assert.equal(releaseRequest.canWithdraw, false);
    await networkHelpers.time.increase(1);
    await alpha.writeContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "releaseFunds",
      args: [releaseRequestTimestamp + ONE_SECOND, releaseTotal],
    });
    const depositorBRequest = await publicClient.readContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "requestInfo",
      args: [DEPOSITOR_B],
    });
    assert.equal(depositorBRequest.canWithdraw, true);

    await networkHelpers.time.increaseTo(endWithdrawWindowTimestamp + 1n);

    const depositorBRequest2 = await publicClient.readContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "requestInfo",
      args: [DEPOSITOR_B],
    });
    assert.equal(depositorBRequest2.canWithdraw, false);
    await assert.rejects(
      depositorB.writeContract({
        address: vault,
        abi: vaultAbi,
        functionName: "redeemFromRequest",
        args: [shares, DEPOSITOR_B, DEPOSITOR_B],
      }),
      /WithdrawManagerInvalidSharesToRelease/,
    );
  });
});
