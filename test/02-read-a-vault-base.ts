// S2 Read a vault: read a vault's fuses, market IDs, substrates, price oracle, asset price,
// total assets and TVL, from a vault this story builds and funds itself.
// It stands alone: steps 01 to 03 repeat S1's setup in short, then deposit and supply to Aave V3
// so every read returns a non-zero value.
// Every step is a real transaction on a Base fork, and a step depends on the steps above it.
// The story skips simulation on purpose, to show the transaction flow. A real app on a real
// chain should simulate before each transaction, to check gas usage and whether it reverts.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { encodeFunctionData, erc20Abi, erc4626Abi, parseAbi, parseEther, parseEventLogs, parseUnits, pad, slice, isAddressEqual, zeroAddress, type Address } from "viem";

// Base addresses, from ipor-abi: mainnet/mainnet-base-fusion/addresses.json at 8b1be92 (factory, Aave V3 fuses),
// mainnet/addresses.json at e228075 (BalanceFuseErc20) and README.md (USDC).
const FACTORY = "0x1455717668fA96534f675856347A973fA907e922";
const AAVE_V3_SUPPLY_FUSE = "0x26fD6EF391E98C78CfCA27e00c3d15be4D941625";
const AAVE_V3_BALANCE_FUSE = "0x952573Ec1B6895a88a95CA523097083d4da4D8e5";
const ERC20_BALANCE_FUSE = "0x9ba147FC382DBf4D73512A45370ba0B70c25F6aa";
// The factory installs this fuse in every clone (BurnRequestFeeFuseV2 in mainnet-base-fusion/addresses.json).
const BURN_REQUEST_FEE_FUSE = "0x7f80241a2b8dA1e11b96B5749991e9A9a40b62a9";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// Morpho Blue on Base holds enough USDC at the fork block to fund the depositor.
const USDC_WHALE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

// Market IDs from IporFusionMarkets.sol (ipor-fusion 004d054) and role IDs from Roles.sol (ipor-fusion 4fdaf50).
const AAVE_V3_MARKET = 1n;
const ERC20_VAULT_BALANCE_MARKET = 7n;
const ZERO_BALANCE_MARKET = 2n ** 256n - 1n;
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

// ABIs from ipor-abi (mainnet/mainnet-base-fusion/abis; IporFusionFactoryImpl and IporFusionAccessManagerBase at 55b2d9e, PlasmaVaultBase at b942366): IporFusionFactory, PlasmaVault (with PlasmaVaultGovernance), IporFusionAccessManager,
// AaveV3SupplyFuse and PriceOracleMiddleware.
const factoryAbi = parseAbi([
  "function clone(string assetName, string assetSymbol, address underlyingToken, uint256 redemptionDelayInSeconds, address owner, uint256 daoFeePackageIndex) returns (FusionInstance)",
  "struct FusionInstance { uint256 index; uint256 version; string assetName; string assetSymbol; uint8 assetDecimals; address underlyingToken; string underlyingTokenSymbol; uint8 underlyingTokenDecimals; address initialOwner; address plasmaVault; address plasmaVaultBase; address accessManager; address feeManager; address rewardsManager; address withdrawManager; address contextManager; address priceManager; }",
  "error InvalidUnderlyingToken()",
  "error InvalidOwner()",
  "error DaoFeePackageIndexOutOfBounds(uint256 index, uint256 length)",
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
  "error NoAssetsToDeposit()",
  "function execute(FuseAction[] calls)",
  "function updateMarketsBalances(uint256[] marketIds) returns (uint256)",
  "function getFuses() view returns (address[])",
  "function getMarketSubstrates(uint256 marketId) view returns (bytes32[])",
  "function getPriceOracleMiddleware() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "error AccessManagedUnauthorized(address caller)",
  "error UnsupportedFuse()",
  "error AaveV3SupplyFuseUnsupportedAsset(string action, address asset)",
]);
const accessManagerAbi = parseAbi([
  "function grantRole(uint64 roleId, address account, uint32 executionDelay)",
  "error AccessManagerUnauthorizedAccount(address msgsender, uint64 roleId)",
]);
const fuseAbi = parseAbi(["function MARKET_ID() view returns (uint256)"]);
const aaveV3SupplyFuseAbi = parseAbi([
  "struct Enter { address asset; uint256 amount; uint256 userEModeCategoryId; }",
  "function enter(Enter data)",
]);
const priceOracleAbi = parseAbi(["function getAssetPrice(address asset) view returns (uint256 assetPrice, uint256 decimals)"]);

const usdc = (amount: string) => parseUnits(amount, 6);

const { viem, networkHelpers } = await network.create("base");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const fuseManager = await viem.getWalletClient(FUSE_MANAGER);
const alpha = await viem.getWalletClient(ALPHA);
const depositor = await viem.getWalletClient(DEPOSITOR);
const balanceUpdater = await viem.getWalletClient(BALANCE_UPDATER);

describe("S2 Read a USDC vault on Aave V3", () => {
  let vault: Address, accessManager: Address, priceOracle: Address, asset: Address;
  let fuses: readonly Address[], marketIds: bigint[], totalAssets: bigint, assetPrice: bigint, priceDecimals: bigint, assetDecimals: number;

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

  it("03 a depositor deposits 1000 USDC and the Alpha supplies 800 of it to Aave V3", async () => {
    // S3 explains the deposit, S7 the Alpha's execute call.
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [vault, usdc("1000")] }) });
    await publicClient.waitForTransactionReceipt({ hash: await depositor.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [usdc("1000"), DEPOSITOR] }) });
    const data = encodeFunctionData({ abi: aaveV3SupplyFuseAbi, functionName: "enter", args: [{ asset: USDC, amount: usdc("800"), userEModeCategoryId: 0n }] });
    await publicClient.waitForTransactionReceipt({ hash: await alpha.writeContract({ address: vault, abi: vaultAbi, functionName: "execute", args: [[{ fuse: AAVE_V3_SUPPLY_FUSE, data }]] }) });

    assert.equal(await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [vault] }), usdc("200"));
  });

  it("04 reads the vault's fuses", async () => {
    fuses = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getFuses" });

    const expected: Address[] = [BURN_REQUEST_FEE_FUSE, AAVE_V3_SUPPLY_FUSE];
    assert.equal(fuses.length, expected.length);
    expected.forEach((fuse, i) => {
      const actual = fuses[i];
      assert.ok(actual && isAddressEqual(actual, fuse), `fuse ${i}: ${actual}`);
    });
  });

  it("05 reads each fuse's market ID", async () => {
    // allowFailure: a fuse without MARKET_ID reports a failure instead of reverting the whole read.
    const results = await publicClient.multicall({ contracts: fuses.map((fuse) => ({ address: fuse, abi: fuseAbi, functionName: "MARKET_ID" })), allowFailure: true });
    const ids = results.flatMap((result) => (result.status === "success" ? [result.result] : []));
    // Several fuses can serve one market, so keep each ID once. A fuse that holds no balance reports ZERO_BALANCE_MARKET.
    marketIds = [...new Set(ids)];

    assert.deepEqual(marketIds, [ZERO_BALANCE_MARKET, AAVE_V3_MARKET]);
  });

  it("06 reads the Aave V3 market's substrates", async () => {
    const substrates = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getMarketSubstrates", args: [AAVE_V3_MARKET] });

    // A substrate is an address left-padded to 32 bytes, so its last 20 bytes are the address.
    assert.equal(substrates.length, 1);
    const [substrate] = substrates;
    assert.ok(substrate, "the market has no substrate");
    assert.ok(isAddressEqual(slice(substrate, 12), USDC));
  });

  it("07 reads the price oracle middleware", async () => {
    priceOracle = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getPriceOracleMiddleware" });

    assert.notEqual(priceOracle, zeroAddress);
  });

  it("08 reads the vault asset and its price in USD from the oracle", async () => {
    asset = await publicClient.readContract({ address: vault, abi: erc4626Abi, functionName: "asset" });
    assetDecimals = await publicClient.readContract({ address: asset, abi: erc20Abi, functionName: "decimals" });
    [assetPrice, priceDecimals] = await publicClient.readContract({ address: priceOracle, abi: priceOracleAbi, functionName: "getAssetPrice", args: [asset] });

    const one = 10n ** priceDecimals;
    assert.ok(assetPrice > (one * 98n) / 100n && assetPrice < (one * 102n) / 100n, `The asset is about 1 USD, got ${assetPrice} / 10^${priceDecimals}`);
  });

  it("09 refreshes market balances with role 1000, then reads total assets", async () => {
    // updateMarketsBalances is restricted to UPDATE_MARKETS_BALANCES_ROLE (see PlasmaVault.updateMarketsBalances).
    await networkHelpers.time.increase(30 * 24 * 60 * 60);
    const totalAssetsBefore = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalAssets" });
    await assert.rejects(
      balanceUpdater.writeContract({ address: vault, abi: vaultAbi, functionName: "updateMarketsBalances", args: [marketIds] }),
      /AccessManagedUnauthorized/,
    );

    // On the access manager: the Atomist grants the role that unlocks updateMarketsBalances on the vault.
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [UPDATE_MARKETS_BALANCES_ROLE, BALANCE_UPDATER, 0] }) });
    await publicClient.waitForTransactionReceipt({ hash: await balanceUpdater.writeContract({ address: vault, abi: vaultAbi, functionName: "updateMarketsBalances", args: [marketIds] }) });
    totalAssets = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalAssets" });

    assert.ok(totalAssetsBefore >= usdc("1000") - 1n, `before: ${totalAssetsBefore}`);
    assert.ok(totalAssets > totalAssetsBefore, `30 days of Aave V3 interest: ${totalAssetsBefore} -> ${totalAssets}`);
  });

  it("10 computes TVL in USD from total assets and the asset price", async () => {
    // TVL keeps the asset's decimals (assetDecimals: 6 for USDC).
    const tvl = (totalAssets * assetPrice) / 10n ** priceDecimals;

    assert.ok(tvl > (totalAssets * 98n) / 100n && tvl < (totalAssets * 102n) / 100n, `TVL ${tvl} for ${totalAssets} (${assetDecimals} decimals)`);
  });
});
