// S4 Private vault: keep a USDC vault private, whitelist an EOA and see which deposits it refuses.
// It stands alone: steps 01 and 02 repeat S1's setup in short (test/01-create-and-configure-base.ts),
// without a market and without convertToPublicVault, so the vault stays private.
// The form values every deposit method shares (balance, Max, USD value, paused, maxDeposit, withdraw note)
// are read as in S3 (test/03-direct-deposit-base.ts). This story shows only what a private vault adds.
// Every step is a real transaction on a Base fork, and a step depends on the steps above it.
// The story skips simulation on purpose, to show the transaction flow. A real app on a real
// chain should simulate before each transaction, to check gas usage and whether it reverts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { erc20Abi, parseAbi, parseEther, parseEventLogs, parseUnits, stringToHex, toFunctionSelector, type Address } from "viem";

// Base addresses, from ipor-abi: mainnet/mainnet-base-fusion/addresses.json at 8b1be92 (factory),
// at f87f303 (ReferralPlasmaVault) and README.md (USDC).
const FACTORY = "0x1455717668fA96534f675856347A973fA907e922";
const REFERRAL_PLASMA_VAULT = "0xecd2bF892E2ee99Cf2CbBc81F6877132E25e34DB";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
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

// ABIs from ipor-abi (mainnet/mainnet-base-fusion/abis; IporFusionFactoryImpl and IporFusionAccessManagerBase at 55b2d9e,
// PlasmaVaultBase at b942366, ReferralPlasmaVault at f87f303).
const factoryAbi = parseAbi([
  "function clone(string assetName, string assetSymbol, address underlyingToken, uint256 redemptionDelayInSeconds, address owner, uint256 daoFeePackageIndex) returns (FusionInstance)",
  "struct FusionInstance { uint256 index; uint256 version; string assetName; string assetSymbol; uint8 assetDecimals; address underlyingToken; string underlyingTokenSymbol; uint8 underlyingTokenDecimals; address initialOwner; address plasmaVault; address plasmaVaultBase; address accessManager; address feeManager; address rewardsManager; address withdrawManager; address contextManager; address priceManager; }",
  "event FusionInstanceCreated(uint256 index, uint256 version, string assetName, string assetSymbol, uint8 assetDecimals, address underlyingToken, string underlyingTokenSymbol, uint8 underlyingTokenDecimals, address initialOwner, address plasmaVault, address plasmaVaultBase, address feeManager)",
]);
const vaultAbi = parseAbi([
  "function getAccessManagerAddress() view returns (address)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function previewDeposit(uint256 assets) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "error AccessManagedUnauthorized(address caller)",
]);
const accessManagerAbi = parseAbi([
  "function grantRole(uint64 roleId, address account, uint32 executionDelay)",
  "function hasRole(uint64 roleId, address account) view returns (bool isMember, uint32 executionDelay)",
  "function getTargetFunctionRole(address target, bytes4 selector) view returns (uint64)",
]);
const referralAbi = parseAbi([
  "function deposit(address vault, uint256 assets, address receiver, bytes32 referralCode) returns (uint256)",
  "error AccessManagedUnauthorized(address caller)",
]);

const { viem, networkHelpers } = await network.create("base");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const depositor = await viem.getWalletClient(DEPOSITOR);
const usdc = (amount: string) => parseUnits(amount, 6);

describe("S4 Private vault: whitelist an EOA and the refused deposits", () => {
  let vault: Address, accessManager: Address;
  const hasRole = async (roleId: bigint, account: Address) => {
    const [isMember] = await publicClient.readContract({ address: accessManager, abi: accessManagerAbi, functionName: "hasRole", args: [roleId, account] });
    return isMember;
  };
  const shares = (account: Address) => publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [account] });

  it("01 clones a USDC vault, as in S1 step 01, and it starts private", async () => {
    const hash = await owner.writeContract({ address: FACTORY, abi: factoryAbi, functionName: "clone", args: ["Private USDC", "pUSDC", USDC, 0n, OWNER, 0n] });
    const { logs } = await publicClient.waitForTransactionReceipt({ hash });
    const [created] = parseEventLogs({ abi: factoryAbi, logs, eventName: "FusionInstanceCreated" });
    assert.ok(created, "the receipt has no FusionInstanceCreated event");
    vault = created.args.plasmaVault;
    accessManager = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getAccessManagerAddress" });

    // A new vault is private: deposit needs WHITELIST_ROLE until the Atomist calls convertToPublicVault, which this story never does.
    const depositRole = await publicClient.readContract({ address: accessManager, abi: accessManagerAbi, functionName: "getTargetFunctionRole", args: [vault, toFunctionSelector("deposit(uint256,address)")] });
    assert.equal(depositRole, WHITELIST_ROLE);
  });

  it("02 the owner grants Atomist, as in S1 step 02", async () => {
    // The Atomist is the admin of WHITELIST_ROLE. No other role is needed: deposits stay idle in the vault, without a market.
    // On the access manager: the Owner grants the Atomist role, which unlocks convertToPublicVault and the role grants that follow.
    await publicClient.waitForTransactionReceipt({ hash: await owner.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [ATOMIST_ROLE, ATOMIST, 0] }) });

    assert.equal(await hasRole(ATOMIST_ROLE, ATOMIST), true);
  });

  it("03 a depositor without WHITELIST_ROLE is refused", async () => {
    // Only the USDC whale needs impersonating: every other account is an unlocked Hardhat default account.
    await networkHelpers.impersonateAccount(USDC_WHALE);
    // Gives the whale ETH to pay gas for its USDC transfer.
    await networkHelpers.setBalance(USDC_WHALE, parseEther("1"));
    const whale = await viem.getWalletClient(USDC_WHALE);
    await publicClient.waitForTransactionReceipt({ hash: await whale.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [DEPOSITOR, usdc("1000")] }) });
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [vault, usdc("1000")] }) });

    assert.equal(await hasRole(WHITELIST_ROLE, DEPOSITOR), false);
    await assert.rejects(
      // Expected to revert: the depositor lacks WHITELIST_ROLE.
      depositor.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [usdc("100"), DEPOSITOR] }),
      /AccessManagedUnauthorized/,
    );
  });

  it("04 the Atomist grants WHITELIST_ROLE to the depositor, an EOA", async () => {
    // As Atomist (admin of WHITELIST_ROLE), grants the depositor WHITELIST_ROLE, which unlocks deposit.
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [WHITELIST_ROLE, DEPOSITOR, 0] }) });

    assert.equal(await hasRole(WHITELIST_ROLE, DEPOSITOR), true);
  });

  it("05 the depositor deposits and receives the shares", async () => {
    const expectedShares = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "previewDeposit", args: [usdc("100")] });
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [usdc("100"), DEPOSITOR] }) });

    assert.ok(expectedShares > 0n);
    assert.equal(await shares(DEPOSITOR), expectedShares);
  });

  it("06 a whitelisted depositor can deposit for a receiver without WHITELIST_ROLE", async () => {
    // Only the caller's role is enforced. PlasmaVault._checkCanCall also asks the access manager about the receiver,
    // but ignores the answer (ipor-fusion 004d054, PlasmaVault.sol:1554-1560).
    assert.equal(await hasRole(WHITELIST_ROLE, RECEIVER), false);
    const expectedShares = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "previewDeposit", args: [usdc("100")] });
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [usdc("100"), RECEIVER] }) });

    assert.equal(await shares(RECEIVER), expectedShares);
  });

  it("07 a referral deposit is refused, because the referral wrapper is the caller", async () => {
    // ReferralPlasmaVault takes the tokens and calls vault.deposit itself, so the vault sees the wrapper as the caller.
    // WHITELIST_ROLE is granted only to EOAs, never to a contract such as the zap or the referral wrapper,
    // so zaps and referral deposits do not work on a private vault. A private vault's form deposits directly.
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [REFERRAL_PLASMA_VAULT, usdc("100")] }) });

    assert.equal(await hasRole(WHITELIST_ROLE, REFERRAL_PLASMA_VAULT), false);
    await assert.rejects(
      // Expected to revert: the depositor is whitelisted, the wrapper is not.
      depositor.writeContract({ address: REFERRAL_PLASMA_VAULT, abi: referralAbi, functionName: "deposit", args: [vault, usdc("100"), DEPOSITOR, stringToHex("story", { size: 32 })] }),
      /AccessManagedUnauthorized/,
    );
  });
});
