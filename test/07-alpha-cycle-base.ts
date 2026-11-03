// S7 Alpha cycle: the Alpha moves vault funds into Aave V3 and back with execute, and a balance updater
// refreshes the stored market balance after time passes.
// It follows S1: steps 01 and 02 repeat S1's setup in short, then a depositor funds the vault.
// Every step is a real transaction on a Base fork, and a step depends on the steps above it.
// The story skips simulation on purpose, to show the transaction flow. A real app on a real
// chain should simulate before each transaction, to check gas usage and whether it reverts.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { encodeFunctionData, erc20Abi, maxUint256, parseAbi, parseEther, parseEventLogs, parseUnits, pad, zeroAddress, type Address } from "viem";

// Base addresses, from ipor-abi: mainnet/mainnet-base-fusion/addresses.json at 8b1be92 (factory, Aave V3 fuses),
// mainnet/addresses.json at e228075 (BalanceFuseErc20) and README.md (USDC).
const FACTORY = "0x1455717668fA96534f675856347A973fA907e922";
const AAVE_V3_SUPPLY_FUSE = "0x26fD6EF391E98C78CfCA27e00c3d15be4D941625";
const AAVE_V3_BALANCE_FUSE = "0x952573Ec1B6895a88a95CA523097083d4da4D8e5";
const ERC20_BALANCE_FUSE = "0x9ba147FC382DBf4D73512A45370ba0B70c25F6aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
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

// Hardhat's default accounts, one per role.
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ATOMIST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const FUSE_MANAGER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ALPHA = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const DEPOSITOR = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const BALANCE_UPDATER = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";

// ABIs from ipor-abi (mainnet/mainnet-base-fusion/abis; IporFusionFactoryImpl, IporFusionAccessManagerBase and
// IporFusionPlasmaVaultCoreBase at 55b2d9e, PlasmaVaultBase and SupplyFuseAaveV3 at b942366): IporFusionFactory, PlasmaVault
// (with PlasmaVaultGovernance), IporFusionAccessManager and SupplyFuseAaveV3.
const factoryAbi = parseAbi([
  "function clone(string assetName, string assetSymbol, address underlyingToken, uint256 redemptionDelayInSeconds, address owner, uint256 daoFeePackageIndex) returns (FusionInstance)",
  "struct FusionInstance { uint256 index; uint256 version; string assetName; string assetSymbol; uint8 assetDecimals; address underlyingToken; string underlyingTokenSymbol; uint8 underlyingTokenDecimals; address initialOwner; address plasmaVault; address plasmaVaultBase; address accessManager; address feeManager; address rewardsManager; address withdrawManager; address contextManager; address priceManager; }",
  "event FusionInstanceCreated(uint256 index, uint256 version, string assetName, string assetSymbol, uint8 assetDecimals, address underlyingToken, string underlyingTokenSymbol, uint8 underlyingTokenDecimals, address initialOwner, address plasmaVault, address plasmaVaultBase, address feeManager)",
]);
const vaultAbi = parseAbi([
  "struct FuseAction { address fuse; bytes data; }",
  "function getAccessManagerAddress() view returns (address)",
  "function addFuses(address[] fuses)",
  "function addBalanceFuse(uint256 marketId, address fuse)",
  "function grantMarketSubstrates(uint256 marketId, bytes32[] substrates)",
  "function updateDependencyBalanceGraphs(uint256[] marketIds, uint256[][] dependencies)",
  "function convertToPublicVault()",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function execute(FuseAction[] calls)",
  "function updateMarketsBalances(uint256[] marketIds) returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalAssetsInMarket(uint256 marketId) view returns (uint256)",
  "error AccessManagedUnauthorized(address caller)",
]);
const accessManagerAbi = parseAbi(["function grantRole(uint64 roleId, address account, uint32 executionDelay)"]);
// The fuse's enter and exit take one struct each. The Alpha sends them ABI-encoded as the data of a FuseAction.
const aaveV3SupplyFuseAbi = parseAbi([
  "struct Enter { address asset; uint256 amount; uint256 userEModeCategoryId; }",
  "struct Exit { address asset; uint256 amount; }",
  "function enter(Enter data)",
  "function exit(Exit data)",
]);

const usdc = (amount: string) => parseUnits(amount, 6);

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
  const idle = () => publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [vault] });
  const inAave = () => publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalAssetsInMarket", args: [AAVE_V3_MARKET] });
  const totalAssets = () => publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalAssets" });
  // A FuseAction is the fuse address and the ABI-encoded call of its enter or exit function.
  const enterAction = (amount: bigint) => ({
    fuse: AAVE_V3_SUPPLY_FUSE as Address,
    data: encodeFunctionData({ abi: aaveV3SupplyFuseAbi, functionName: "enter", args: [{ asset: USDC, amount, userEModeCategoryId: 0n }] }),
  });
  const exitAction = (amount: bigint) => ({
    fuse: AAVE_V3_SUPPLY_FUSE as Address,
    data: encodeFunctionData({ abi: aaveV3SupplyFuseAbi, functionName: "exit", args: [{ asset: USDC, amount }] }),
  });

  before(async () => {
    // Only the USDC whale needs impersonating: every other account is an unlocked Hardhat default account.
    await networkHelpers.impersonateAccount(USDC_WHALE);
    // Gives the whale ETH to pay gas for its USDC transfer.
    await networkHelpers.setBalance(USDC_WHALE, parseEther("1"));
    const whale = await viem.getWalletClient(USDC_WHALE);
    await publicClient.waitForTransactionReceipt({ hash: await whale.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [DEPOSITOR, usdc("1000")] }) });
  });

  it("01 clones a vault and grants its roles, as in S1", async () => {
    const hash = await owner.writeContract({ address: FACTORY, abi: factoryAbi, functionName: "clone", args: ["Story USDC", "sUSDC", USDC, 0n, OWNER, 0n] });
    const { logs } = await publicClient.waitForTransactionReceipt({ hash });
    const [created] = parseEventLogs({ abi: factoryAbi, logs, eventName: "FusionInstanceCreated" });
    assert.ok(created, "the receipt has no FusionInstanceCreated event");
    vault = created.args.plasmaVault;
    accessManager = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getAccessManagerAddress" });
    // On the access manager: the Owner grants the Atomist role, which unlocks role grants and convertToPublicVault on the vault.
    await publicClient.waitForTransactionReceipt({ hash: await owner.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [ATOMIST_ROLE, ATOMIST, 0] }) });
    // On the access manager: Fuse Manager unlocks addFuses and grantMarketSubstrates on the vault.
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [FUSE_MANAGER_ROLE, FUSE_MANAGER, 0] }) });
    // On the access manager: Alpha unlocks execute on the vault.
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [ALPHA_ROLE, ALPHA, 0] }) });

    assert.notEqual(vault, zeroAddress);
  });

  it("02 installs Aave V3 and opens deposits to everyone, as in S1", async () => {
    const usdcSubstrate = pad(USDC, { size: 32 });
    await publicClient.waitForTransactionReceipt({ hash: await fuseManager.writeContract({ address: vault, abi: vaultAbi, functionName: "addFuses", args: [[AAVE_V3_SUPPLY_FUSE]] }) });
    await publicClient.waitForTransactionReceipt({ hash: await fuseManager.writeContract({ address: vault, abi: vaultAbi, functionName: "addBalanceFuse", args: [AAVE_V3_MARKET, AAVE_V3_BALANCE_FUSE] }) });
    await publicClient.waitForTransactionReceipt({ hash: await fuseManager.writeContract({ address: vault, abi: vaultAbi, functionName: "addBalanceFuse", args: [ERC20_VAULT_BALANCE_MARKET, ERC20_BALANCE_FUSE] }) });
    await publicClient.waitForTransactionReceipt({ hash: await fuseManager.writeContract({ address: vault, abi: vaultAbi, functionName: "grantMarketSubstrates", args: [AAVE_V3_MARKET, [usdcSubstrate]] }) });
    await publicClient.waitForTransactionReceipt({ hash: await fuseManager.writeContract({ address: vault, abi: vaultAbi, functionName: "grantMarketSubstrates", args: [ERC20_VAULT_BALANCE_MARKET, [usdcSubstrate]] }) });
    await publicClient.waitForTransactionReceipt({ hash: await fuseManager.writeContract({ address: vault, abi: vaultAbi, functionName: "updateDependencyBalanceGraphs", args: [[AAVE_V3_MARKET], [[ERC20_VAULT_BALANCE_MARKET]]] }) });
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: vault, abi: vaultAbi, functionName: "convertToPublicVault" }) });
  });

  it("03 a depositor deposits 1000 USDC", async () => {
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [vault, usdc("1000")] }) });
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [usdc("1000"), DEPOSITOR] }) });

    assert.equal(await idle(), usdc("1000"));
    assert.equal(await inAave(), 0n);
  });

  it("04 the depositor cannot execute: only the Alpha may move funds", async () => {
    await assert.rejects(
      // Expected to revert: execute is restricted to ALPHA_ROLE.
      depositor.writeContract({ address: vault, abi: vaultAbi, functionName: "execute", args: [[enterAction(usdc("300"))]] }),
      /AccessManagedUnauthorized/,
    );
  });

  it("05 the Alpha enters Aave V3 with 300 USDC", async () => {
    const idleBefore = await idle();
    await publicClient.waitForTransactionReceipt({ hash: await alpha.writeContract({ address: vault, abi: vaultAbi, functionName: "execute", args: [[enterAction(usdc("300"))]] }) });

    assert.equal(await idle(), idleBefore - usdc("300"));
    // Aave rounds the aToken balance down by at most a unit or two.
    const inAaveNow = await inAave();
    assert.ok(inAaveNow >= usdc("300") - 2n, `in Aave: ${inAaveNow}`);
  });

  it("06 the Atomist grants a balance updater, then 30 days later the stored market balance is stale", async () => {
    // On the access manager: the Atomist grants the role that unlocks updateMarketsBalances on the vault.
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [UPDATE_MARKETS_BALANCES_ROLE, BALANCE_UPDATER, 0] }) });
    storedBefore = await inAave();
    totalAssetsBefore = await totalAssets();
    await networkHelpers.time.increase(30 * 24 * 60 * 60);

    // Aave pays interest into the aToken balance, but the vault stores the market balance until it is refreshed.
    assert.equal(await inAave(), storedBefore);
    assert.equal(await totalAssets(), totalAssetsBefore);
    // The chain moved on: the vault's live aUSDC balance is already above the stored market balance.
    const liveAave = await publicClient.readContract({ address: AAVE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [vault] });
    assert.ok(liveAave > storedBefore, `live aUSDC ${liveAave} vs stored ${storedBefore}`);
  });

  it("07 the balance updater refreshes the Aave V3 market and total assets grow", async () => {
    await publicClient.waitForTransactionReceipt({ hash: await balanceUpdater.writeContract({ address: vault, abi: vaultAbi, functionName: "updateMarketsBalances", args: [[AAVE_V3_MARKET]] }) });

    const totalAssetsAfter = await totalAssets();
    const inAaveAfter = await inAave();
    assert.ok(totalAssetsAfter > totalAssetsBefore, `30 days of Aave V3 interest: ${totalAssetsBefore} -> ${totalAssetsAfter}`);
    assert.ok(inAaveAfter > storedBefore, `in Aave: ${inAaveAfter}`);
  });

  it("08 the Alpha exits everything with the maximum amount", async () => {
    // The fuse exits min(aToken balance, amount), so type(uint256).max unwinds the whole position, interest included.
    // The story supplies 300 and not more on purpose: at the fork block the Aave V3 USDC reserve has almost no free liquidity
    // beyond what the vault supplies, so a withdraw above supply + ~2 USDC fails, and the fuse swallows that failure (AaveV3SupplyFuseExitFailed).
    await publicClient.waitForTransactionReceipt({ hash: await alpha.writeContract({ address: vault, abi: vaultAbi, functionName: "execute", args: [[exitAction(maxUint256)]] }) });

    const idleAfter = await idle();
    assert.ok(idleAfter > usdc("1000"), `idle: ${idleAfter}`);
    assert.equal(await inAave(), 0n);
  });
});
