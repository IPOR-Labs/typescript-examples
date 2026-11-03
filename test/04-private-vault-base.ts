// S4 Private vault: keep a USDC vault private, whitelist an EOA and see which deposits it refuses.
// It stands alone: steps 01 and 02 repeat S1's setup in short (test/01-create-and-configure-base.ts),
// without a market and without convertToPublicVault, so the vault stays private.
// The values every deposit method shares (balance, USD value, paused, maxDeposit, withdraw note)
// are read as in S3 (test/03-direct-deposit-base.ts). This story shows only what a private vault adds.
// Every step is a real transaction on a Base fork, and a step depends on the steps above it.
// The story skips simulation on purpose, to show the transaction flow. A real app on a real
// chain should simulate before each transaction, to check gas usage and whether it reverts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { erc20Abi, parseEther, parseEventLogs, parseUnits, stringToHex, toFunctionSelector, type Address } from "viem";
import { accessManagerAbi } from "../abis/accessManager.abi.ts";
import { factoryAbi } from "../abis/factory.abi.ts";
import { referralAbi } from "../abis/referral.abi.ts";
import { vaultAbi } from "../abis/vault.abi.ts";

// Base addresses, from ipor-abi: mainnet/mainnet-base-fusion/addresses.json at 8b1be92 (factory),
// at f87f303 (ReferralPlasmaVault) and README.md (USDC).
const FACTORY = "0x1455717668fA96534f675856347A973fA907e922";
const REFERRAL_PLASMA_VAULT = "0xecd2bF892E2ee99Cf2CbBc81F6877132E25e34DB";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// USDC has 6 decimals.
const USDC_DECIMALS = 6;
// Morpho Blue on Base holds enough USDC at the fork block to fund the depositor.
const USDC_WHALE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

// Role IDs from Roles.sol (ipor-fusion 4fdaf50).
const ATOMIST_ROLE = 100n;
const WHITELIST_ROLE = 800n;

// Hardhat's default accounts. The depositor and the receiver are EOAs.
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ATOMIST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DEPOSITOR = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const RECEIVER = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";

const DEPOSIT_SELECTOR = toFunctionSelector("deposit(uint256,address)");
// grantRole: the grant takes effect without an execution delay.
const NO_EXECUTION_DELAY = 0;
const REFERRAL_CODE = stringToHex("story", { size: 32 });
const amount1000Usdc = parseUnits("1000", USDC_DECIMALS);
const amount100Usdc = parseUnits("100", USDC_DECIMALS);

const VAULT_NAME = "Private USDC";
const VAULT_SYMBOL = "pUSDC";
const REDEMPTION_DELAY = 0n;
const DAO_FEE_PACKAGE_INDEX = 0n;

const GAS_TOP_UP = parseEther("1");

const { viem, networkHelpers } = await network.create("base");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const depositor = await viem.getWalletClient(DEPOSITOR);

describe("S4 Private vault: whitelist an EOA and the refused deposits", () => {
  let vault: Address, accessManager: Address;

  it("01 clones a USDC vault, as in S1 step 01, and it starts private", async () => {
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

    // A new vault is private: deposit needs WHITELIST_ROLE until the Atomist calls convertToPublicVault, which this story never does.
    const depositRole = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "getTargetFunctionRole",
      args: [vault, DEPOSIT_SELECTOR],
    });
    assert.equal(depositRole, WHITELIST_ROLE);
  });

  it("02 the owner grants Atomist, as in S1 step 02", async () => {
    // The Atomist is the admin of WHITELIST_ROLE. No other role is needed: deposits stay idle in the vault, without a market.
    assert.equal((await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [ATOMIST_ROLE, ATOMIST],
    }))[0], false);
    // On the access manager: the Owner grants the Atomist role, which unlocks the role grants that follow.
    await owner.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [ATOMIST_ROLE, ATOMIST, NO_EXECUTION_DELAY],
    });

    const [atomistHasRole] = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [ATOMIST_ROLE, ATOMIST],
    });

    assert.equal(atomistHasRole, true);
  });

  it("03 a depositor without WHITELIST_ROLE is refused", async () => {
    // Only the USDC whale needs impersonating: every other account is an unlocked Hardhat default account.
    await networkHelpers.impersonateAccount(USDC_WHALE);
    // Gives the whale ETH to pay gas for its USDC transfer.
    await networkHelpers.setBalance(USDC_WHALE, GAS_TOP_UP);
    const whale = await viem.getWalletClient(USDC_WHALE);
    const depositorUsdcBalance = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    });
    assert.equal(depositorUsdcBalance, 0n);
    await whale.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "transfer",
      args: [DEPOSITOR, amount1000Usdc],
    });
    const [depositorUsdc, depositorAllowance] = await Promise.all([
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "allowance",
        args: [DEPOSITOR, vault],
      }),
    ]);
    assert.equal(depositorUsdc, amount1000Usdc);
    assert.equal(depositorAllowance, 0n);
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

    const [depositorHasRole] = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [WHITELIST_ROLE, DEPOSITOR],
    });

    assert.equal(depositorHasRole, false);
    await assert.rejects(
      // Expected to revert: the depositor lacks WHITELIST_ROLE.
      depositor.writeContract({
        address: vault,
        abi: vaultAbi,
        functionName: "deposit",
        args: [amount100Usdc, DEPOSITOR],
      }),
      /AccessManagedUnauthorized/,
    );
  });

  it("04 the Atomist grants WHITELIST_ROLE to the depositor, an EOA", async () => {
    assert.equal((await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [WHITELIST_ROLE, DEPOSITOR],
    }))[0], false);
    // As Atomist (admin of WHITELIST_ROLE), grants the depositor WHITELIST_ROLE, which unlocks deposit.
    await atomist.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [WHITELIST_ROLE, DEPOSITOR, NO_EXECUTION_DELAY],
    });

    const [depositorHasRole] = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [WHITELIST_ROLE, DEPOSITOR],
    });

    assert.equal(depositorHasRole, true);
  });

  it("05 the depositor deposits and receives the shares", async () => {
    const [expectedShares, sharesBefore] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "previewDeposit",
        args: [amount100Usdc],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
    ]);
    assert.equal(sharesBefore, 0n);
    await depositor.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "deposit",
      args: [amount100Usdc, DEPOSITOR],
    });
    const depositorShares = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    });
    assert.ok(expectedShares > 0n);
    assert.equal(depositorShares, expectedShares);
  });

  it("06 a whitelisted depositor can deposit for a receiver without WHITELIST_ROLE", async () => {
    // Only the caller's role is enforced. PlasmaVault._checkCanCall also asks the access manager about the receiver,
    // but ignores the answer (ipor-fusion 004d054, PlasmaVault.sol:1554-1560).
    const [[receiverHasRole], expectedShares, receiverSharesBefore] = await Promise.all([
      publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "hasRole",
        args: [WHITELIST_ROLE, RECEIVER],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "previewDeposit",
        args: [amount100Usdc],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [RECEIVER],
      }),
    ]);
    assert.equal(receiverHasRole, false);
    assert.equal(receiverSharesBefore, 0n);
    await depositor.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "deposit",
      args: [amount100Usdc, RECEIVER],
    });
    const receiverShares = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "balanceOf",
      args: [RECEIVER],
    });
    assert.equal(receiverShares, expectedShares);
  });

  it("07 a referral deposit is refused, because the referral wrapper is the caller", async () => {
    // ReferralPlasmaVault takes the tokens and calls vault.deposit itself, so the vault sees the wrapper as the caller.
    // WHITELIST_ROLE is granted only to EOAs, never to a contract such as the zap or the referral wrapper,
    // so zaps and referral deposits do not work on a private vault. A private vault takes deposits directly.
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

    const [referralPlasmaVaultHasRole] = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [WHITELIST_ROLE, REFERRAL_PLASMA_VAULT],
    });

    assert.equal(referralPlasmaVaultHasRole, false);
    await assert.rejects(
      // Expected to revert: the depositor is whitelisted, the wrapper is not.
      depositor.writeContract({
        address: REFERRAL_PLASMA_VAULT,
        abi: referralAbi,
        functionName: "deposit",
        args: [vault, amount100Usdc, DEPOSITOR, REFERRAL_CODE],
      }),
      /AccessManagedUnauthorized/,
    );
  });
});
