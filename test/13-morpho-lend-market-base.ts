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
import { encodeFunctionData, erc20Abi, maxUint256, parseAbi, parseEther, parseEventLogs, parseUnits, zeroAddress, type Address, type Hex } from "viem";

// Base addresses, from ipor-abi: mainnet/mainnet-base-fusion/addresses.json at 8b1be92 (factory),
// mainnet/addresses.json at e228075 (Morpho supply and balance fuses) and README.md (USDC).
const FACTORY = "0x1455717668fA96534f675856347A973fA907e922";
const MORPHO_SUPPLY_FUSE = "0xae93EF3cf337b9599F0dfC12520c3C281637410F";
const MORPHO_BALANCE_FUSE = "0x7916856E11E0CA021967D0D4daC49D737b7d73d5";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// The Morpho Blue market cbBTC/USDC 86% on Base, held by Morpho Blue 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb.
// A Morpho market id is already 32 bytes, so it is the substrate as it is.
const MORPHO_MARKET_ID: Hex = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";
// An EOA that holds about 158M USDC at the fork block.
const USDC_WHALE = "0x8da91A6298eA5d1A8Bc985e99798fd0A0f05701a";

// Market IDs from IporFusionMarkets.sol (ipor-fusion 004d054) and role IDs from Roles.sol (ipor-fusion 4fdaf50).
const MORPHO_MARKET = 14n;
const ATOMIST_ROLE = 100n;
const ALPHA_ROLE = 200n;
const FUSE_MANAGER_ROLE = 300n;
const UPDATE_MARKETS_BALANCES_ROLE = 1000n;

// Hardhat's default accounts, one per role.
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ATOMIST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const FUSE_MANAGER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ALPHA = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";
const BALANCE_UPDATER = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";

// ABIs from ipor-abi (mainnet/mainnet-base-fusion/abis; IporFusionFactoryImpl and IporFusionAccessManagerBase at 55b2d9e, PlasmaVaultBase at b942366): IporFusionFactory, PlasmaVault (with PlasmaVaultGovernance),
// IporFusionAccessManager and MorphoSupplyFuse.
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
  "function convertToPublicVault()",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function execute(FuseAction[] calls)",
  "function updateMarketsBalances(uint256[] marketIds) returns (uint256)",
  "function isFuseSupported(address fuse) view returns (bool)",
  "function isBalanceFuseSupported(uint256 marketId, address fuse) view returns (bool)",
  "function isMarketSubstrateGranted(uint256 marketId, bytes32 substrate) view returns (bool)",
  "function totalAssets() view returns (uint256)",
  "function totalAssetsInMarket(uint256 marketId) view returns (uint256)",
  "error AccessManagedUnauthorized(address caller)",
]);
const accessManagerAbi = parseAbi(["function grantRole(uint64 roleId, address account, uint32 executionDelay)"]);
const morphoSupplyFuseAbi = parseAbi([
  "struct MorphoSupplyFuseEnterData { bytes32 morphoMarketId; uint256 amount; }",
  "struct MorphoSupplyFuseExitData { bytes32 morphoMarketId; uint256 amount; }",
  "function enter(MorphoSupplyFuseEnterData data)",
  "function exit(MorphoSupplyFuseExitData data)",
]);

const usdc = (amount: string) => parseUnits(amount, 6);

const { viem, networkHelpers } = await network.create("base");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const fuseManager = await viem.getWalletClient(FUSE_MANAGER);
const alpha = await viem.getWalletClient(ALPHA);
const balanceUpdater = await viem.getWalletClient(BALANCE_UPDATER);

describe("S13 Morpho Lend market on one Morpho Blue market", () => {
  let vault: Address, accessManager: Address;
  const totalAssets = () => publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalAssets" });
  const inMarket = () => publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "totalAssetsInMarket", args: [MORPHO_MARKET] });
  const idle = () => publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [vault] });

  before(async () => {
    // Only the USDC whale needs impersonating: every other account is an unlocked Hardhat default account.
    await networkHelpers.impersonateAccount(USDC_WHALE);
    // Gives the whale ETH to pay gas.
    await networkHelpers.setBalance(USDC_WHALE, parseEther("1"));
  });

  it("01 clones a vault and grants its roles, as in S1", async () => {
    const hash = await owner.writeContract({ address: FACTORY, abi: factoryAbi, functionName: "clone", args: ["Story USDC", "sUSDC", USDC, 0n, OWNER, 0n] });
    const { logs } = await publicClient.waitForTransactionReceipt({ hash });
    const [created] = parseEventLogs({ abi: factoryAbi, logs, eventName: "FusionInstanceCreated" });
    assert.ok(created, "the receipt has no FusionInstanceCreated event");
    vault = created.args.plasmaVault;
    accessManager = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getAccessManagerAddress" });
    // On the access manager: the Owner grants Atomist, then the Atomist grants Fuse Manager and Alpha.
    await publicClient.waitForTransactionReceipt({ hash: await owner.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [ATOMIST_ROLE, ATOMIST, 0] }) });
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [FUSE_MANAGER_ROLE, FUSE_MANAGER, 0] }) });
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [ALPHA_ROLE, ALPHA, 0] }) });
    // The Atomist opens deposits to everyone.
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: vault, abi: vaultAbi, functionName: "convertToPublicVault" }) });

    assert.notEqual(vault, zeroAddress);
  });

  it("02 the whale deposits 10000 USDC", async () => {
    // S3 explains the deposit.
    const whale = await viem.getWalletClient(USDC_WHALE);
    await publicClient.waitForTransactionReceipt({ hash: await whale.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [vault, usdc("10000")] }) });
    await publicClient.waitForTransactionReceipt({ hash: await whale.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [usdc("10000"), USDC_WHALE] }) });

    assert.equal(await idle(), usdc("10000"));
  });

  it("03 the Fuse Manager installs the Morpho market: supply fuse, balance fuse and the Morpho Blue market id as substrate", async () => {
    // Enter and exit are both (morphoMarketId, amount).
    await publicClient.waitForTransactionReceipt({ hash: await fuseManager.writeContract({ address: vault, abi: vaultAbi, functionName: "addFuses", args: [[MORPHO_SUPPLY_FUSE]] }) });
    await publicClient.waitForTransactionReceipt({ hash: await fuseManager.writeContract({ address: vault, abi: vaultAbi, functionName: "addBalanceFuse", args: [MORPHO_MARKET, MORPHO_BALANCE_FUSE] }) });
    // Grant the id on market 14 only. Do not also grant it on market 41 (MORPHO_LIQUIDITY_IN_MARKETS):
    // both balance fuses would then count the same position, and total assets would count it twice.
    // grantMarketSubstrates replaces the market's whole list.
    await publicClient.waitForTransactionReceipt({ hash: await fuseManager.writeContract({ address: vault, abi: vaultAbi, functionName: "grantMarketSubstrates", args: [MORPHO_MARKET, [MORPHO_MARKET_ID]] }) });

    assert.equal(await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "isFuseSupported", args: [MORPHO_SUPPLY_FUSE] }), true);
    assert.equal(await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "isBalanceFuseSupported", args: [MORPHO_MARKET, MORPHO_BALANCE_FUSE] }), true);
    assert.equal(await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "isMarketSubstrateGranted", args: [MORPHO_MARKET, MORPHO_MARKET_ID] }), true);
  });

  it("04 the Alpha supplies 8000 USDC to the Morpho market through execute", async () => {
    const data = encodeFunctionData({ abi: morphoSupplyFuseAbi, functionName: "enter", args: [{ morphoMarketId: MORPHO_MARKET_ID, amount: usdc("8000") }] });
    await publicClient.waitForTransactionReceipt({ hash: await alpha.writeContract({ address: vault, abi: vaultAbi, functionName: "execute", args: [[{ fuse: MORPHO_SUPPLY_FUSE, data }]] }) });

    // The market reads the position in assets. It differs from the amount entered by rounding of a few wei.
    const position = await inMarket();
    assert.ok(position >= usdc("8000") - 10n && position <= usdc("8000") + 10n, `in market: ${position}`);
    assert.equal(await idle(), usdc("2000"));
  });

  it("05 a balance updater refreshes the market after a day and total assets grow", async () => {
    // On the access manager: the Atomist grants the role that unlocks updateMarketsBalances on the vault, as in S2.
    await publicClient.waitForTransactionReceipt({ hash: await atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [UPDATE_MARKETS_BALANCES_ROLE, BALANCE_UPDATER, 0] }) });
    await networkHelpers.time.increase(24 * 60 * 60);
    const totalAssetsBefore = await totalAssets();
    await publicClient.waitForTransactionReceipt({ hash: await balanceUpdater.writeContract({ address: vault, abi: vaultAbi, functionName: "updateMarketsBalances", args: [[MORPHO_MARKET]] }) });
    const totalAssetsAfter = await totalAssets();

    assert.ok(totalAssetsAfter > totalAssetsBefore, `one day of interest: ${totalAssetsBefore} -> ${totalAssetsAfter}`);
  });

  it("06 the Alpha exits the market in full and the funds are idle again", async () => {
    // An amount at or above the position exits all of it: reading the position and exiting exactly that can leave a few wei of rounding.
    const data = encodeFunctionData({ abi: morphoSupplyFuseAbi, functionName: "exit", args: [{ morphoMarketId: MORPHO_MARKET_ID, amount: maxUint256 }] });
    await publicClient.waitForTransactionReceipt({ hash: await alpha.writeContract({ address: vault, abi: vaultAbi, functionName: "execute", args: [[{ fuse: MORPHO_SUPPLY_FUSE, data }]] }) });

    assert.equal(await inMarket(), 0n);
    assert.ok((await idle()) > usdc("10000"), `idle: ${await idle()}`);
  });
});
