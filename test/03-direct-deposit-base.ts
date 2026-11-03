// S3 Direct deposit: read every value a deposit form shows, then deposit into a public USDC vault
// directly, with a referral code, and under a 1% deposit fee.
// It stands alone: step 01 repeats S1's setup in short, without a market, so deposits stay idle in the vault.
// Every step is a real transaction on a Base fork, and a step depends on the steps above it.
// The story skips simulation on purpose, to show the transaction flow. A real app on a real
// chain should simulate before each transaction, to check gas usage and whether it reverts.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { erc20Abi, parseAbi, parseEther, parseEventLogs, parseUnits, slice, stringToHex, toFunctionSelector, isAddressEqual, zeroAddress, type Address } from "viem";

// Base addresses, from ipor-abi: mainnet/mainnet-base-fusion/addresses.json at 8b1be92 (factory, ReferralPlasmaVault)
// and README.md (USDC).
const FACTORY = "0x1455717668fA96534f675856347A973fA907e922";
const REFERRAL_PLASMA_VAULT = "0xecd2bF892E2ee99Cf2CbBc81F6877132E25e34DB";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
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

// ABIs from ipor-abi (mainnet/mainnet-base-fusion/abis; IporFusionFactoryImpl and IporFusionAccessManagerBase at 55b2d9e,
// PlasmaVaultBase at b942366, IporFusionWithdrawManagerBase, PriceOracleMiddlewareUsdImpl), and from ipor-fusion 004d054
// for FeeManager.sol and ReferralPlasmaVault.sol, which ipor-abi does not publish for Base.
const factoryAbi = parseAbi([
  "function clone(string assetName, string assetSymbol, address underlyingToken, uint256 redemptionDelayInSeconds, address owner, uint256 daoFeePackageIndex) returns (FusionInstance)",
  "struct FusionInstance { uint256 index; uint256 version; string assetName; string assetSymbol; uint8 assetDecimals; address underlyingToken; string underlyingTokenSymbol; uint8 underlyingTokenDecimals; address initialOwner; address plasmaVault; address plasmaVaultBase; address accessManager; address feeManager; address rewardsManager; address withdrawManager; address contextManager; address priceManager; }",
  "error InvalidUnderlyingToken()",
  "error InvalidOwner()",
  "error DaoFeePackageIndexOutOfBounds(uint256 index, uint256 length)",
  "event FusionInstanceCreated(uint256 index, uint256 version, string assetName, string assetSymbol, uint8 assetDecimals, address underlyingToken, string underlyingTokenSymbol, uint8 underlyingTokenDecimals, address initialOwner, address plasmaVault, address plasmaVaultBase, address feeManager)",
]);
const vaultAbi = parseAbi([
  "function getAccessManagerAddress() view returns (address)",
  "function convertToPublicVault()",
  "function getPriceOracleMiddleware() view returns (address)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function maxDeposit(address receiver) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "error AccessManagedUnauthorized(address caller)",
  "error NoAssetsToDeposit()",
  "error ERC4626ExceededMaxDeposit(address receiver, uint256 assets, uint256 max)",
]);
const accessManagerAbi = parseAbi([
  "function grantRole(uint64 roleId, address account, uint32 executionDelay)",
  "function getTargetFunctionRole(address target, bytes4 selector) view returns (uint64)",
  "function isTargetClosed(address target) view returns (bool)",
  "error AccessManagerUnauthorizedAccount(address msgsender, uint64 roleId)",
]);
const priceOracleAbi = parseAbi(["function getAssetPrice(address asset) view returns (uint256 assetPrice, uint256 decimals)"]);
const withdrawManagerAbi = parseAbi(["function getWithdrawWindow() view returns (uint256)"]);
const feeManagerAbi = parseAbi([
  "function setDepositFee(uint256 fee)",
  "function getDepositFee() view returns (uint256)",
  "function calculateDepositFee(uint256 shares) view returns (uint256)",
  "error InvalidDepositFee(uint256 fee)",
  "error AccessManagedUnauthorized(address caller)",
]);
const referralAbi = parseAbi([
  "function deposit(address vault, uint256 assets, address receiver, bytes32 referralCode) returns (uint256)",
  "event ReferralEvent(address indexed referrer, bytes32 referralCode)",
]);

const usdc = (amount: string) => parseUnits(amount, 6);

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
    await networkHelpers.setBalance(USDC_WHALE, parseEther("1"));
    const whale = await viem.getWalletClient(USDC_WHALE);
    await publicClient.waitForTransactionReceipt({ hash: await whale.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [DEPOSITOR, usdc("5000")] }) });
  });

  it("01 clones a vault, grants the Atomist and opens deposits to everyone, as in S1", async () => {
    const hash = await owner.writeContract({ address: FACTORY, abi: factoryAbi, functionName: "clone", args: ["Story USDC", "sUSDC", USDC, 0n, OWNER, 0n] });
    const { logs } = await publicClient.waitForTransactionReceipt({ hash });
    const [created] = parseEventLogs({ abi: factoryAbi, logs, eventName: "FusionInstanceCreated" });
    assert.ok(created, "the receipt has no FusionInstanceCreated event");
    vault = created.args.plasmaVault;
    feeManager = created.args.feeManager;
    accessManager = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getAccessManagerAddress" });
    const slot = await publicClient.getStorageAt({ address: vault, slot: WITHDRAW_MANAGER_SLOT });
    assert.ok(slot, "the Withdraw Manager slot is empty");
    // An address in a storage slot is its last 20 bytes.
    withdrawManager = slice(slot, 12);
    // On the access manager: the Owner grants the Atomist role, which unlocks convertToPublicVault and setDepositFee.
    await publicClient.waitForTransactionReceipt({ hash: await owner.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [ATOMIST_ROLE, ATOMIST, 0] }) });
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: vault, abi: vaultAbi, functionName: "convertToPublicVault" }) });

    assert.ok(!isAddressEqual(vault, zeroAddress));
    assert.ok(!isAddressEqual(withdrawManager, zeroAddress));
  });

  it("02 reads the values every deposit form shows, for an amount of 1000 USDC", async () => {
    const amount = usdc("1000");

    // Balance label. Max is the balance for an ERC-20 (Max of a native balance keeps 5% back for gas: NATIVE_ETH_MAX_FILL_PERCENT = 95n in https://github.com/IPOR-Labs/ipor-webapp/blob/220fe2a0a794f4194f6b5895febeb65e95839bb0/src/fusion/deposit/deposit-token-amount/deposit-token-amount.types.tsx#L14).
    const balance = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [DEPOSITOR] });
    const max = balance;
    assert.equal(balance, usdc("5000"));
    assert.equal(max, usdc("5000"));

    // USD value under the amount: the price comes from the vault's own oracle, scaled to 18 decimals as the UI does.
    const oracle = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getPriceOracleMiddleware" });
    const [price, priceDecimals] = await publicClient.readContract({ address: oracle, abi: priceOracleAbi, functionName: "getAssetPrice", args: [USDC] });
    const price18 = (price * 10n ** 18n) / 10n ** priceDecimals;
    const assetDecimals = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "decimals" });
    const usdValue18 = (amount * price18) / 10n ** BigInt(assetDecimals);
    assert.ok(usdValue18 > parseEther("980") && usdValue18 < parseEther("1020"), `1000 USDC is about 1000 USD, got ${usdValue18} / 1e18`);

    // Public: deposit is open to PUBLIC_ROLE. On a private vault the form checks hasRole(800, account) instead (S4).
    const depositRole = await publicClient.readContract({ address: accessManager, abi: accessManagerAbi, functionName: "getTargetFunctionRole", args: [vault, toFunctionSelector("deposit(uint256,address)")] });
    assert.equal(depositRole, PUBLIC_ROLE);

    // Paused: a closed target disables the submit button.
    assert.equal(await publicClient.readContract({ address: accessManager, abi: accessManagerAbi, functionName: "isTargetClosed", args: [vault] }), false);

    // Limit: the submit button is disabled when the amount exceeds maxDeposit. A factory vault has no cap.
    const maxDeposit = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "maxDeposit", args: [DEPOSITOR] });
    assert.ok(maxDeposit >= amount, `maxDeposit ${maxDeposit}`);

    // "Withdraw: Scheduled" note: the wait the UI shows is window - window / 2. A factory vault starts with a one-day window.
    const withdrawWindow = await publicClient.readContract({ address: withdrawManager, abi: withdrawManagerAbi, functionName: "getWithdrawWindow" });
    const waitSeconds = withdrawWindow - withdrawWindow / 2n;
    assert.equal(withdrawWindow, 86400n);
    assert.equal(waitSeconds, 43200n);
  });

  it("03 the depositor approves the vault and deposits 1000 USDC directly", async () => {
    const amount = usdc("1000");
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [vault, amount] }) });
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [amount, DEPOSITOR] }) });

    // Shares have the asset's decimals plus 2, so the first 1000 USDC in an empty vault mints 1000 * 10^8 shares.
    const decimals = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "decimals" });
    assert.equal(decimals, 8);
    assert.equal(await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [DEPOSITOR] }), parseUnits("1000", 8));
    assert.equal(await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [vault] }), amount);
  });

  it("04 the depositor deposits 100 USDC through ReferralPlasmaVault with a referral code", async () => {
    // With a referral code the UI approves the wrapper, not the vault, and deposits through it. The wrapper pulls the USDC,
    // emits ReferralEvent with the caller as referrer, and deposits for the receiver.
    const amount = usdc("100");
    const referralCode = stringToHex("story-s3", { size: 32 });
    const sharesBefore = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [DEPOSITOR] });
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [REFERRAL_PLASMA_VAULT, amount] }) });
    const hash = await depositor.writeContract({ address: REFERRAL_PLASMA_VAULT, abi: referralAbi, functionName: "deposit", args: [vault, amount, DEPOSITOR, referralCode] });
    const { logs } = await publicClient.waitForTransactionReceipt({ hash });

    const events = parseEventLogs({ abi: referralAbi, logs, eventName: "ReferralEvent" });
    assert.equal(events.length, 1);
    const [event] = events;
    assert.ok(event && isAddressEqual(event.args.referrer, DEPOSITOR), `referrer ${event?.args.referrer}`);
    assert.equal(event.args.referralCode, referralCode);
    const minted = (await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [DEPOSITOR] })) - sharesBefore;
    assert.equal(minted, parseUnits("100", 8));
  });

  it("05 the Atomist sets a 1% deposit fee on the fee manager", async () => {
    // Fees have 18 decimals: 1e16 is 1%. setDepositFee is restricted to ATOMIST_ROLE.
    const fee = parseEther("0.01");
    await assert.rejects(
      // Expected to revert: the depositor holds no Atomist role.
      depositor.writeContract({ address: feeManager, abi: feeManagerAbi, functionName: "setDepositFee", args: [fee] }),
      /AccessManagedUnauthorized/,
    );
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: feeManager, abi: feeManagerAbi, functionName: "setDepositFee", args: [fee] }) });

    assert.equal(await publicClient.readContract({ address: feeManager, abi: feeManagerAbi, functionName: "getDepositFee" }), fee);
  });

  it("06 computes \"Onboarding contribution\" and \"Net deposit\" for 1000 USDC, then deposits and matches the chain", async () => {
    const amount = usdc("1000");
    // The UI's chain of reads: the amount in shares, the fee in shares, then the fee back in assets.
    const shares = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "convertToShares", args: [amount] });
    const feeShares = await publicClient.readContract({ address: feeManager, abi: feeManagerAbi, functionName: "calculateDepositFee", args: [shares] });
    const contribution = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "convertToAssets", args: [feeShares] });
    const netDeposit = amount - contribution;
    // Management fees accrue every block, so a value read now can drift by a few wei by the time the deposit lands.
    const tolerance = usdc("0.01");
    assert.ok(contribution >= usdc("10") - tolerance && contribution <= usdc("10") + tolerance, `contribution ${contribution}`);

    const sharesBefore = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [DEPOSITOR] });
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [vault, amount] }) });
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [amount, DEPOSITOR] }) });
    const minted = (await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [DEPOSITOR] })) - sharesBefore;
    const mintedAssets = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "convertToAssets", args: [minted] });

    // The depositor's new shares are worth the Net deposit: 990 of 1000 USDC.
    assert.ok(mintedAssets >= usdc("990") - tolerance && mintedAssets <= usdc("990") + tolerance, `minted shares are worth ${mintedAssets}`);
    assert.ok(mintedAssets >= netDeposit - tolerance && mintedAssets <= netDeposit + tolerance, `net deposit ${netDeposit}, chain ${mintedAssets}`);
  });
});
