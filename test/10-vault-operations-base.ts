// S10 Vault operations: read the DAO fee package, set management and performance fees, watch them
// accrue and harvest them, cap the supply and turn on share transfers.
// It stands alone: step 01 repeats S1's clone, Atomist grant and public switch in short, without a market,
// so the vault runs on idle USDC.
// Every step is a real transaction on a Base fork, and a step depends on the steps above it.
// The story skips simulation on purpose, to show the transaction flow. A real app on a real
// chain should simulate before each transaction, to check gas usage and whether it reverts.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { erc20Abi, parseAbi, parseEther, parseEventLogs, parseUnits, type Address } from "viem";

// Base addresses, from ipor-abi: mainnet/mainnet-base-fusion/addresses.json at 8b1be92 (factory) and README.md (USDC).
const FACTORY = "0x1455717668fA96534f675856347A973fA907e922";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// An EOA holding about 158.3M USDC at the fork block, used to fund the depositor.
const USDC_WHALE = "0x8da91A6298eA5d1A8Bc985e99798fd0A0f05701a";

// Role IDs from Roles.sol (ipor-fusion 4fdaf50).
const ATOMIST_ROLE = 100n;

// Hardhat's default accounts. The fee recipient, the harvester and the share receiver hold no role.
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ATOMIST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DEPOSITOR = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const FEE_RECIPIENT = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
const HARVESTER = "0x976EA74026E726554dB657fA54763abd0C3a0aa9";
const SHARE_RECEIVER = "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955";

// ABIs from ipor-abi (mainnet/mainnet-base-fusion/abis): IporFusionFactoryImpl and IporFusionAccessManagerBase at 55b2d9e,
// PlasmaVaultBase at b942366, IporFusionPlasmaVaultCoreBase at 55b2d9e.
const factoryAbi = parseAbi([
  "function clone(string assetName, string assetSymbol, address underlyingToken, uint256 redemptionDelayInSeconds, address owner, uint256 daoFeePackageIndex) returns (FusionInstance)",
  "struct FusionInstance { uint256 index; uint256 version; string assetName; string assetSymbol; uint8 assetDecimals; address underlyingToken; string underlyingTokenSymbol; uint8 underlyingTokenDecimals; address initialOwner; address plasmaVault; address plasmaVaultBase; address accessManager; address feeManager; address rewardsManager; address withdrawManager; address contextManager; address priceManager; }",
  "error InvalidUnderlyingToken()",
  "error InvalidOwner()",
  "error DaoFeePackageIndexOutOfBounds(uint256 index, uint256 length)",
  "event FusionInstanceCreated(uint256 index, uint256 version, string assetName, string assetSymbol, uint8 assetDecimals, address underlyingToken, string underlyingTokenSymbol, uint8 underlyingTokenDecimals, address initialOwner, address plasmaVault, address plasmaVaultBase, address feeManager)",
]);
// Written by hand: ipor-abi's Base folder has no getDaoFeePackages. Source: ipor-fusion 004d054,
// contracts/factory/FusionFactory.sol (getDaoFeePackages) and contracts/factory/lib/FusionFactoryStorageLib.sol (FeePackage).
const factoryFeeAbi = parseAbi([
  "struct FeePackage { uint256 managementFee; uint256 performanceFee; address feeRecipient; }",
  "function getDaoFeePackages() view returns (FeePackage[])",
]);
const vaultAbi = parseAbi([
  "function getAccessManagerAddress() view returns (address)",
  "function convertToPublicVault()",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function getUnrealizedManagementFee() view returns (uint256)",
  "function maxDeposit(address receiver) view returns (uint256)",
  "function setTotalSupplyCap(uint256 cap)",
  "function enableTransferShares()",
  "error AccessManagedUnauthorized(address caller)",
  "error ERC4626ExceededMaxDeposit(address receiver, uint256 assets, uint256 max)",
  "error WrongValue()",
]);
const accessManagerAbi = parseAbi([
  "function grantRole(uint64 roleId, address account, uint32 executionDelay)",
  "error AccessManagerUnauthorizedAccount(address msgsender, uint64 roleId)",
]);
// Written by hand: ipor-abi's Base folder has no FeeManager ABI. Source: ipor-fusion 004d054,
// contracts/managers/fee/FeeManager.sol, contracts/managers/fee/FeeManagerFactory.sol (RecipientFee)
// and contracts/libraries/PlasmaVaultLib.sol (the fee errors, raised by the vault and bubbled up).
const feeManagerAbi = parseAbi([
  "struct RecipientFee { address recipient; uint256 feeValue; }",
  "function updateManagementFee(RecipientFee[] recipientFees)",
  "function updatePerformanceFee(RecipientFee[] recipientFees)",
  "function getTotalManagementFee() view returns (uint256)",
  "function getTotalPerformanceFee() view returns (uint256)",
  "function getIporDaoFeeRecipientAddress() view returns (address)",
  "function harvestAllFees()",
  "function MANAGEMENT_FEE_ACCOUNT() view returns (address)",
  "function PERFORMANCE_FEE_ACCOUNT() view returns (address)",
  "error InvalidManagementFee(uint256 feeInPercentage)",
  "error InvalidPerformanceFee(uint256 feeInPercentage)",
  "error AccessManagedUnauthorized(address caller)",
]);

const usdc = (amount: string) => parseUnits(amount, 6);
const ONE_YEAR = 365 * 24 * 60 * 60;

const { viem, networkHelpers } = await network.create("base");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const depositor = await viem.getWalletClient(DEPOSITOR);
const harvester = await viem.getWalletClient(HARVESTER);

describe("S10 Operate a USDC vault: fees, supply cap and share transfers", () => {
  let vault: Address, feeManager: Address;
  const shares = (account: Address) => publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "balanceOf", args: [account] });

  before(async () => {
    // Only the USDC whale needs impersonating: every other account is an unlocked Hardhat default account.
    await networkHelpers.impersonateAccount(USDC_WHALE);
    // Gives the whale ETH to pay gas for its USDC transfer.
    await networkHelpers.setBalance(USDC_WHALE, parseEther("1"));
    const whale = await viem.getWalletClient(USDC_WHALE);
    await publicClient.waitForTransactionReceipt({ hash: await whale.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [DEPOSITOR, usdc("2000")] }) });
  });

  it("01 clones a vault on DAO fee package 0, grants Atomist, goes public and takes a deposit, as in S1", async () => {
    // The last clone argument picks the DAO fee package by index.
    const hash = await owner.writeContract({ address: FACTORY, abi: factoryAbi, functionName: "clone", args: ["Story USDC", "sUSDC", USDC, 0n, OWNER, 0n] });
    const { logs } = await publicClient.waitForTransactionReceipt({ hash });
    const [created] = parseEventLogs({ abi: factoryAbi, logs, eventName: "FusionInstanceCreated" });
    assert.ok(created, "the receipt has no FusionInstanceCreated event");
    vault = created.args.plasmaVault;
    feeManager = created.args.feeManager;
    const accessManager = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getAccessManagerAddress" });
    // On the access manager: the Atomist unlocks the fee, supply cap and transfer settings below.
    await publicClient.waitForTransactionReceipt({ hash: await owner.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [ATOMIST_ROLE, ATOMIST, 0] }) });
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: vault, abi: vaultAbi, functionName: "convertToPublicVault" }) });
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [vault, usdc("2000")] }) });
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [usdc("1000"), DEPOSITOR] }) });

    assert.ok((await shares(DEPOSITOR)) > 0n);
  });

  it("02 reads the DAO fee package the vault was cloned with", async () => {
    // Fees are in basis points: 10000 = 100%. The DAO takes its share before any fee the Atomist sets.
    const [package0] = await publicClient.readContract({ address: FACTORY, abi: factoryFeeAbi, functionName: "getDaoFeePackages" });
    assert.ok(package0, "the factory has no DAO fee package");
    assert.equal(package0.managementFee, 5n);
    assert.equal(package0.performanceFee, 1000n);
    assert.equal(await publicClient.readContract({ address: feeManager, abi: feeManagerAbi, functionName: "getTotalManagementFee" }), 5n);
    assert.equal(await publicClient.readContract({ address: feeManager, abi: feeManagerAbi, functionName: "getTotalPerformanceFee" }), 1000n);
  });

  it("03 the Atomist sets a 200 bps management and 1000 bps performance fee for a recipient", async () => {
    // Each call replaces the whole recipient list, and harvests the fees accrued so far first.
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: feeManager, abi: feeManagerAbi, functionName: "updateManagementFee", args: [[{ recipient: FEE_RECIPIENT, feeValue: 200n }]] }) });
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: feeManager, abi: feeManagerAbi, functionName: "updatePerformanceFee", args: [[{ recipient: FEE_RECIPIENT, feeValue: 1000n }]] }) });

    // The totals add the DAO fee: 5 + 200 and 1000 + 1000.
    assert.equal(await publicClient.readContract({ address: feeManager, abi: feeManagerAbi, functionName: "getTotalManagementFee" }), 205n);
    assert.equal(await publicClient.readContract({ address: feeManager, abi: feeManagerAbi, functionName: "getTotalPerformanceFee" }), 2000n);
    await assert.rejects(
      // Expected to revert: the 500 bps management limit (5000 for performance) counts the DAO fee, so 600 + 5 = 605.
      atomist.writeContract({ address: feeManager, abi: feeManagerAbi, functionName: "updateManagementFee", args: [[{ recipient: FEE_RECIPIENT, feeValue: 600n }]] }),
      /InvalidManagementFee.*605/s,
    );
  });

  it("04 the management fee accrues over a year and a deposit mints it as fee shares", async () => {
    const managementFeeAccount = await publicClient.readContract({ address: feeManager, abi: feeManagerAbi, functionName: "MANAGEMENT_FEE_ACCOUNT" });
    const sharesBefore = await shares(managementFeeAccount);
    await networkHelpers.time.increase(ONE_YEAR);

    // In USDC, before any fee share exists. Deposit, mint, withdraw and redeem realize it.
    assert.ok((await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getUnrealizedManagementFee" })) > 0n);
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [usdc("100"), DEPOSITOR] }) });

    assert.ok((await shares(managementFeeAccount)) > sharesBefore);
    assert.equal(await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getUnrealizedManagementFee" }), 0n);
  });

  it("05 a gain above the high-water mark mints the performance fee on a withdraw", async () => {
    const performanceFeeAccount = await publicClient.readContract({ address: feeManager, abi: feeManagerAbi, functionName: "PERFORMANCE_FEE_ACCOUNT" });
    const sharesBefore = await shares(performanceFeeAccount);
    // A USDC donation to the vault stands in for a gain. Real gains come from markets (S7).
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [vault, usdc("100")] }) });
    // Withdraw, redeem, execute and updateMarketsBalances realize the performance fee. A deposit does not.
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: vault, abi: vaultAbi, functionName: "withdraw", args: [usdc("1"), DEPOSITOR, DEPOSITOR] }) });

    assert.ok((await shares(performanceFeeAccount)) > sharesBefore);
  });

  it("06 an account with no role harvests the fees to the recipient and the DAO", async () => {
    const dao = await publicClient.readContract({ address: feeManager, abi: feeManagerAbi, functionName: "getIporDaoFeeRecipientAddress" });
    const recipientBefore = await shares(FEE_RECIPIENT);
    const daoBefore = await shares(dao);
    // harvestAllFees has no role, so a keeper can automate it. It moves shares out of the fee accounts and mints nothing.
    await publicClient.waitForTransactionReceipt({ hash: await harvester.writeContract({ address: feeManager, abi: feeManagerAbi, functionName: "harvestAllFees" }) });

    assert.ok((await shares(FEE_RECIPIENT)) > recipientBefore);
    assert.ok((await shares(dao)) > daoBefore);
  });

  it("07 the Atomist caps the supply in shares and a deposit above the room reverts", async () => {
    // The cap counts shares, with 8 decimals (USDC's 6 plus the vault's offset of 2). It defaults to the uint256 maximum.
    const totalSupply = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalSupply" });
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: vault, abi: vaultAbi, functionName: "setTotalSupplyCap", args: [totalSupply + parseUnits("50", 8)] }) });

    // maxDeposit gives the room left in assets, the value a deposit form should show.
    const maxDeposit = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "maxDeposit", args: [DEPOSITOR] });
    assert.ok(maxDeposit > 0n && maxDeposit < usdc("100"));
    await assert.rejects(
      // Expected to revert: the deposit is 1 USDC over the room left.
      depositor.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [maxDeposit + usdc("1"), DEPOSITOR] }),
      /ERC4626ExceededMaxDeposit/,
    );
  });

  it("08 share transfers are off until the Atomist enables them", async () => {
    const amount = parseUnits("10", 8);
    await assert.rejects(
      // Expected to revert: a new vault restricts transfer and transferFrom to a role no holder has.
      depositor.writeContract({ address: vault, abi: vaultAbi, functionName: "transfer", args: [SHARE_RECEIVER, amount] }),
      /AccessManagedUnauthorized/,
    );
    // Opens transfer and transferFrom to everyone. There is no call to turn them off again.
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: vault, abi: vaultAbi, functionName: "enableTransferShares" }) });
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: vault, abi: vaultAbi, functionName: "transfer", args: [SHARE_RECEIVER, amount] }) });

    assert.equal(await shares(SHARE_RECEIVER), amount);
  });
});
