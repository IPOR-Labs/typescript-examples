// S3 Direct deposit: read every value a deposit needs up front, then deposit into a public USDC vault
// directly, with a referral code, and under a 1% deposit fee.
// It stands alone: step 01 repeats S1's setup in short, without a market, so deposits stay idle in the vault.
// Every step is a real transaction on a Base fork, and a step depends on the steps above it.
// The story skips simulation on purpose, to show the transaction flow. A real app on a real
// chain should simulate before each transaction, to check gas usage and whether it reverts.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import {
  erc20Abi,
  parseEther,
  parseEventLogs,
  parseUnits,
  slice,
  stringToHex,
  toFunctionSelector,
  isAddressEqual,
  zeroAddress,
  type Address,
} from "viem";
import { accessManagerAbi } from "../abis/accessManager.abi.ts";
import { factoryAbi } from "../abis/factory.abi.ts";
import { feeManagerAbi } from "../abis/feeManager.abi.ts";
import { priceOracleAbi } from "../abis/priceOracle.abi.ts";
import { referralAbi } from "../abis/referral.abi.ts";
import { vaultAbi } from "../abis/vault.abi.ts";
import { withdrawManagerAbi } from "../abis/withdrawManager.abi.ts";

// Base addresses, from ipor-abi: mainnet/mainnet-base-fusion/addresses.json at 8b1be92 (factory, ReferralPlasmaVault)
// and README.md (USDC).
const FACTORY = "0x1455717668fA96534f675856347A973fA907e922";
const REFERRAL_PLASMA_VAULT = "0xecd2bF892E2ee99Cf2CbBc81F6877132E25e34DB";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// USDC has 6 decimals.
const USDC_DECIMALS = 6;
// Vault shares have the asset's decimals plus 2.
const VAULT_SHARE_DECIMALS = 8;
const VAULT_NAME = "Story USDC";
const VAULT_SYMBOL = "sUSDC";
const REDEMPTION_DELAY = 0n;
const DAO_FEE_PACKAGE_INDEX = 0n;
// Morpho Blue on Base holds enough USDC at the fork block to fund the depositor.
const USDC_WHALE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
// The vault has no getter for its Withdraw Manager. WITHDRAW_MANAGER in PlasmaVaultStorageLib.sol (ipor-fusion 004d054)
// is the storage slot that holds it; the webapp reads the same slot (ipor-webapp src/fusion/withdraw-manager/hooks/use-withdraw-manager-address.ts at 350b2f75b).
const WITHDRAW_MANAGER_SLOT = "0x465d2ff0062318fe6f4c7e9ac78cfcd70bc86a1d992722875ef83a9770513100";

// Role IDs from Roles.sol (ipor-fusion 4fdaf50).
const ATOMIST_ROLE = 100n;
const PUBLIC_ROLE = 2n ** 64n - 1n;

// Hardhat's default accounts, one per role.
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ATOMIST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DEPOSITOR = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";


const DEPOSIT_SELECTOR = toFunctionSelector("deposit(uint256,address)");
// grantRole: the grant takes effect without an execution delay.
const NO_EXECUTION_DELAY = 0;
const amount5000Usdc = parseUnits("5000", USDC_DECIMALS);
const amount1000Usdc = parseUnits("1000", USDC_DECIMALS);
const amount100Usdc = parseUnits("100", USDC_DECIMALS);
const amount10Usdc = parseUnits("10", USDC_DECIMALS);
const amount990Usdc = parseUnits("990", USDC_DECIMALS);
const amount1000Shares = parseUnits("1000", VAULT_SHARE_DECIMALS);
const amount100Shares = parseUnits("100", VAULT_SHARE_DECIMALS);

const tolerance0_01Usdc = parseUnits("0.01", USDC_DECIMALS);
// A client scales the oracle price to 18 decimals.
const PRICE_SCALE_DECIMALS = 18n;

const GAS_TOP_UP = parseEther("1");
const feeOnePercent = parseEther("0.01");
const ONE_DAY_SECONDS = 86400n;
const USD_LOWER_BOUND = parseEther("980");
const USD_UPPER_BOUND = parseEther("1020");

const { viem, networkHelpers } = await network.create("base");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const depositor = await viem.getWalletClient(DEPOSITOR);

describe("S3 Direct deposit into a public USDC vault", () => {
  let vault: Address, accessManager: Address, feeManager: Address, withdrawManager: Address;

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
      args: [DEPOSITOR, amount5000Usdc],
    });
  });

  it("01 clones a vault, grants the Atomist and opens deposits to everyone, as in S1", async () => {
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
    feeManager = created.args.feeManager;
    accessManager = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "getAccessManagerAddress",
    });
    const slot = await publicClient.getStorageAt({ address: vault, slot: WITHDRAW_MANAGER_SLOT });
    assert.ok(slot, "the Withdraw Manager slot is empty");
    // An address in a storage slot is its last 20 bytes.
    withdrawManager = slice(slot, 12);
    const [[atomistHasRoleBefore], depositTargetFunctionRoleBefore] = await Promise.all([
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
        args: [vault, DEPOSIT_SELECTOR],
      }),
    ]);
    assert.equal(atomistHasRoleBefore, false);
    assert.notEqual(depositTargetFunctionRoleBefore, PUBLIC_ROLE);
    // On the access manager: the Owner grants the Atomist role, which unlocks convertToPublicVault and setDepositFee.
    await owner.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [ATOMIST_ROLE, ATOMIST, NO_EXECUTION_DELAY],
    });
    await atomist.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "convertToPublicVault",
    });

    const [[atomistHasRole], depositTargetFunctionRole] = await Promise.all([
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
        args: [vault, DEPOSIT_SELECTOR],
      }),
    ]);
    assert.equal(atomistHasRole, true);
    assert.equal(depositTargetFunctionRole, PUBLIC_ROLE);
    assert.ok(!isAddressEqual(vault, zeroAddress));
    assert.ok(!isAddressEqual(withdrawManager, zeroAddress));
  });

  it("02 reads the values every deposit shows up front, for an amount of 1000 USDC", async () => {

    // The depositor's full balance for an ERC-20. For a native balance the read keeps 5% back for gas: NATIVE_ETH_MAX_FILL_PERCENT = 95n in https://github.com/IPOR-Labs/ipor-webapp/blob/220fe2a0a794f4194f6b5895febeb65e95839bb0/src/fusion/deposit/deposit-token-amount/deposit-token-amount.types.tsx#L14.
    const depositorBalanceUsdc = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    });
    assert.equal(depositorBalanceUsdc, amount5000Usdc);

    // USD value under the amount: the price comes from the vault's own oracle, scaled to 18 decimals as a client does.
    const priceOracleMiddleware = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "getPriceOracleMiddleware",
    });
    const [priceUsdc, priceUsdcDecimals] = await publicClient.readContract({
      address: priceOracleMiddleware,
      abi: priceOracleAbi,
      functionName: "getAssetPrice",
      args: [USDC],
    });
    const price18 = (priceUsdc * 10n ** PRICE_SCALE_DECIMALS) / 10n ** priceUsdcDecimals;
    const assetDecimals = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "decimals",
    });
    const usdValue18 = (amount1000Usdc * price18) / 10n ** BigInt(assetDecimals);
    assert.ok(
      usdValue18 > USD_LOWER_BOUND && usdValue18 < USD_UPPER_BOUND,
      `1000 USDC is about 1000 USD, got ${usdValue18} / 1e18`,
    );

    // Public: deposit is open to PUBLIC_ROLE. A private vault checks hasRole(800, account) instead (S4).
    const depositRole = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "getTargetFunctionRole",
      args: [vault, DEPOSIT_SELECTOR],
    });
    assert.equal(depositRole, PUBLIC_ROLE);

    // Paused: a closed target blocks deposits.
    const vaultTargetClosed = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "isTargetClosed",
      args: [vault],
    });
    assert.equal(vaultTargetClosed, false);

    // Limit: deposits are blocked when the amount exceeds maxDeposit. A factory vault has no cap.
    const maxDeposit = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "maxDeposit",
      args: [DEPOSITOR],
    });
    assert.ok(maxDeposit >= amount1000Usdc, `maxDeposit ${maxDeposit}`);

    // A factory vault starts with a one-day withdraw window.
    const withdrawWindow = await publicClient.readContract({
      address: withdrawManager,
      abi: withdrawManagerAbi,
      functionName: "getWithdrawWindow",
    });
    assert.equal(withdrawWindow, ONE_DAY_SECONDS);
  });

  it("03 the depositor approves the vault and deposits 1000 USDC directly", async () => {
    const [depositorAllowance, depositorSharesBefore, vaultUsdcBefore] = await Promise.all([
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "allowance",
        args: [DEPOSITOR, vault],
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
        args: [vault],
      }),
    ]);
    assert.equal(depositorAllowance, 0n);
    assert.equal(depositorSharesBefore, 0n);
    assert.equal(vaultUsdcBefore, 0n);
    await depositor.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "approve",
      args: [vault, amount1000Usdc],
    });
    const depositorAllowanceUsdc = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [DEPOSITOR, vault],
    });
    assert.equal(depositorAllowanceUsdc, amount1000Usdc);
    await depositor.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "deposit",
      args: [amount1000Usdc, DEPOSITOR],
    });

    // Shares have the asset's decimals plus 2, so the first 1000 USDC in an empty vault mints 1000 * 10^8 shares.
    const decimals = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "decimals",
    });
    assert.equal(decimals, 8);
    const [depositorShares, vaultUsdc] = await Promise.all([
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
        args: [vault],
      }),
    ]);
    assert.equal(depositorShares, amount1000Shares);
    assert.equal(vaultUsdc, amount1000Usdc);
  });

  it("04 the depositor deposits 100 USDC through ReferralPlasmaVault with a referral code", async () => {
    // With a referral code a client approves the wrapper, not the vault, and deposits through it. The wrapper pulls the USDC,
    // emits ReferralEvent with the caller as referrer, and deposits for the receiver.
    const referralCode = stringToHex("story-s3", { size: 32 });
    const sharesBefore = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    });
    const depositorAllowanceUsdcBefore = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [DEPOSITOR, REFERRAL_PLASMA_VAULT],
    });
    assert.equal(depositorAllowanceUsdcBefore, 0n);
    await depositor.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "approve",
      args: [REFERRAL_PLASMA_VAULT, amount100Usdc],
    });
    const depositorAllowanceUsdcAfter = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [DEPOSITOR, REFERRAL_PLASMA_VAULT],
    });
    assert.equal(depositorAllowanceUsdcAfter, amount100Usdc);
    const hash = await depositor.writeContract({
      address: REFERRAL_PLASMA_VAULT,
      abi: referralAbi,
      functionName: "deposit",
      args: [vault, amount100Usdc, DEPOSITOR, referralCode],
    });
    const { logs } = await publicClient.waitForTransactionReceipt({ hash });

    const events = parseEventLogs({ abi: referralAbi, logs, eventName: "ReferralEvent" });
    assert.equal(events.length, 1);
    const [event] = events;
    assert.ok(event && isAddressEqual(event.args.referrer, DEPOSITOR), `referrer ${event?.args.referrer}`);
    assert.equal(event.args.referralCode, referralCode);
    const minted = (await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    })) - sharesBefore;
    assert.equal(minted, amount100Shares);
  });

  it("05 the Atomist sets a 1% deposit fee on the fee manager", async () => {
    // Fees have 18 decimals: 1e16 is 1%. setDepositFee is restricted to ATOMIST_ROLE.
    const depositFeeBefore = await publicClient.readContract({
      address: feeManager,
      abi: feeManagerAbi,
      functionName: "getDepositFee",
    });
    assert.equal(depositFeeBefore, 0n);
    await assert.rejects(
      // Expected to revert: the depositor holds no Atomist role.
      depositor.writeContract({
        address: feeManager,
        abi: feeManagerAbi,
        functionName: "setDepositFee",
        args: [feeOnePercent],
      }),
      /AccessManagedUnauthorized/,
    );
    await atomist.writeContract({
      address: feeManager,
      abi: feeManagerAbi,
      functionName: "setDepositFee",
      args: [feeOnePercent],
    });

    const depositFeeAfter = await publicClient.readContract({
      address: feeManager,
      abi: feeManagerAbi,
      functionName: "getDepositFee",
    });
    assert.equal(depositFeeAfter, feeOnePercent);
  });

  it("06 computes \"Onboarding contribution\" and \"Net deposit\" for 1000 USDC, then deposits and matches the chain", async () => {
    // A client's chain of reads: the amount in shares, the fee in shares, then the fee back in assets.
    const shares = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "convertToShares",
      args: [amount1000Usdc],
    });
    const feeShares = await publicClient.readContract({
      address: feeManager,
      abi: feeManagerAbi,
      functionName: "calculateDepositFee",
      args: [shares],
    });
    const contribution = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "convertToAssets",
      args: [feeShares],
    });
    const netDeposit = amount1000Usdc - contribution;
    // Management fees accrue every block, so a value read now can drift by a few wei by the time the deposit lands.
    assert.ok(
      contribution >= amount10Usdc - tolerance0_01Usdc && contribution <= amount10Usdc + tolerance0_01Usdc,
      `contribution ${contribution}`,
    );

    const sharesBefore = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    });
    const depositorAllowanceUsdcBefore = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [DEPOSITOR, vault],
    });
    assert.equal(depositorAllowanceUsdcBefore, 0n);
    await depositor.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "approve",
      args: [vault, amount1000Usdc],
    });
    const depositorAllowanceUsdcAfter = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [DEPOSITOR, vault],
    });
    assert.equal(depositorAllowanceUsdcAfter, amount1000Usdc);
    await depositor.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "deposit",
      args: [amount1000Usdc, DEPOSITOR],
    });
    const minted = (await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    })) - sharesBefore;
    const mintedAssets = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "convertToAssets",
      args: [minted],
    });

    // The depositor's new shares are worth the Net deposit: 990 of 1000 USDC.
    assert.ok(
      mintedAssets >= amount990Usdc - tolerance0_01Usdc && mintedAssets <= amount990Usdc + tolerance0_01Usdc,
      `minted shares are worth ${mintedAssets}`,
    );
    assert.ok(
      mintedAssets >= netDeposit - tolerance0_01Usdc && mintedAssets <= netDeposit + tolerance0_01Usdc,
      `net deposit ${netDeposit}, chain ${mintedAssets}`,
    );
  });
});
