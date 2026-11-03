// S1 Create and configure: clone a Plasma Vault from the factory, set up its roles,
// install the Aave V3 Lend market and open the vault to every depositor.
// This is the first story. Every later story starts from a vault built this way.
// Every step is a real transaction on a Base fork, and a step depends on the steps above it.
// The story skips simulation on purpose, to show the transaction flow. A real app on a real
// chain should simulate before each transaction, to check gas usage and whether it reverts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseAbi,parseEventLogs, pad, toFunctionSelector, isAddressEqual, zeroAddress, type Address } from "viem";

// Base addresses, from ipor-abi on main: mainnet/mainnet-base-fusion/addresses.json (factory, Aave V3 fuses),
// mainnet/addresses.json (BalanceFuseErc20) and README.md (USDC).
const FACTORY = "0x1455717668fA96534f675856347A973fA907e922";
const AAVE_V3_SUPPLY_FUSE = "0x26fD6EF391E98C78CfCA27e00c3d15be4D941625";
const AAVE_V3_BALANCE_FUSE = "0x952573Ec1B6895a88a95CA523097083d4da4D8e5";
const ERC20_BALANCE_FUSE = "0x9ba147FC382DBf4D73512A45370ba0B70c25F6aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Market IDs from IporFusionMarkets.sol and role IDs from Roles.sol, in ipor-fusion on main.
const AAVE_V3_MARKET = 1n;
const ERC20_VAULT_BALANCE_MARKET = 7n;
const OWNER_ROLE = 1n;
const ATOMIST_ROLE = 100n;
const ALPHA_ROLE = 200n;
const FUSE_MANAGER_ROLE = 300n;
const PUBLIC_ROLE = 2n ** 64n - 1n;

// Hardhat's default accounts, one per role.
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ATOMIST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const FUSE_MANAGER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ALPHA = "0x90F79bf6EB2c4f870365E785982E1f101E93b906";

// ABIs from ipor-abi on main: IporFusionFactory, PlasmaVault (with PlasmaVaultGovernance) and IporFusionAccessManager.
const factoryAbi = parseAbi([
  "function clone(string assetName, string assetSymbol, address underlyingToken, uint256 redemptionDelayInSeconds, address owner, uint256 daoFeePackageIndex) returns (FusionInstance)",
  "struct FusionInstance { uint256 index; uint256 version; string assetName; string assetSymbol; uint8 assetDecimals; address underlyingToken; string underlyingTokenSymbol; uint8 underlyingTokenDecimals; address initialOwner; address plasmaVault; address plasmaVaultBase; address accessManager; address feeManager; address rewardsManager; address withdrawManager; address contextManager; address priceManager; }",
  "error InvalidUnderlyingToken()",
  "error InvalidOwner()",
  "error DaoFeePackageIndexOutOfBounds(uint256 index, uint256 length)",
  "event FusionInstanceCreated(uint256 index, uint256 version, string assetName, string assetSymbol, uint8 assetDecimals, address underlyingToken, string underlyingTokenSymbol, uint8 underlyingTokenDecimals, address initialOwner, address plasmaVault, address plasmaVaultBase, address feeManager)",
]);
const vaultAbi = parseAbi([
  "function asset() view returns (address)",
  "function getAccessManagerAddress() view returns (address)",
  "function addFuses(address[] fuses)",
  "function addBalanceFuse(uint256 marketId, address fuse)",
  "function grantMarketSubstrates(uint256 marketId, bytes32[] substrates)",
  "function updateDependencyBalanceGraphs(uint256[] marketIds, uint256[][] dependencies)",
  "function convertToPublicVault()",
  "function isFuseSupported(address fuse) view returns (bool)",
  "function isBalanceFuseSupported(uint256 marketId, address fuse) view returns (bool)",
  "function isMarketSubstrateGranted(uint256 marketId, bytes32 substrate) view returns (bool)",
  "function getDependencyBalanceGraph(uint256 marketId) view returns (uint256[])",
  "error AccessManagedUnauthorized(address caller)",
]);
const accessManagerAbi = parseAbi([
  "function grantRole(uint64 roleId, address account, uint32 executionDelay)",
  "function hasRole(uint64 roleId, address account) view returns (bool isMember, uint32 executionDelay)",
  "function getTargetFunctionRole(address target, bytes4 selector) view returns (uint64)",
  "error AccessManagerUnauthorizedAccount(address msgsender, uint64 roleId)",
  "error TooShortExecutionDelayForRole(uint64 roleId, uint32 executionDelay)",
]);

const { viem } =await network.create("base");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const fuseManager = await viem.getWalletClient(FUSE_MANAGER);

describe("S1 Create and configure a USDC vault on Aave V3", () => {
  let vault: Address, accessManager: Address;
  const hasRole = async (roleId: bigint, account: Address) => {
    const [isMember] = await publicClient.readContract({ address: accessManager, abi: accessManagerAbi, functionName: "hasRole", args: [roleId, account] });
    return isMember;
  };

  it("01 clones a vault from the factory and reads the created addresses from the receipt", async () => {
    // Arguments: share name and symbol, underlying token, redemption delay, owner, DAO fee package.
    const hash = await owner.writeContract({ address: FACTORY, abi: factoryAbi, functionName: "clone", args: ["Story USDC", "sUSDC", USDC, 0n, OWNER, 0n] });
    const { logs } = await publicClient.getTransactionReceipt({ hash });
    const [created] = parseEventLogs({ abi: factoryAbi, logs, eventName: "FusionInstanceCreated" });
    vault = created.args.plasmaVault;
    accessManager = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getAccessManagerAddress" });

    assert.notEqual(vault, zeroAddress);
    assert.notEqual(created.args.feeManager, zeroAddress);
    assert.ok(isAddressEqual(await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "asset" }), USDC));
    assert.equal(await hasRole(OWNER_ROLE, OWNER), true);
  });

  it("02 the owner grants Atomist, and only Atomist", async () => {
    await owner.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [ATOMIST_ROLE, ATOMIST, 0] });

    assert.equal(await hasRole(ATOMIST_ROLE, ATOMIST), true);
    await assert.rejects(
      owner.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [ALPHA_ROLE, ALPHA, 0] }),
      /AccessManagerUnauthorizedAccount/,
    );
  });

  it("03 the Atomist grants Fuse Manager and Alpha", async () => {
    await atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [FUSE_MANAGER_ROLE, FUSE_MANAGER, 0] });
    await atomist.writeContract({ address: accessManager, abi: accessManagerAbi, functionName: "grantRole", args: [ALPHA_ROLE, ALPHA, 0] });

    assert.equal(await hasRole(FUSE_MANAGER_ROLE, FUSE_MANAGER), true);
    assert.equal(await hasRole(ALPHA_ROLE, ALPHA), true);
  });

  it("04 the Fuse Manager installs Aave V3: fuse, balance fuses, substrates, then the dependency", async () => {
    await fuseManager.writeContract({ address: vault, abi: vaultAbi, functionName: "addFuses", args: [[AAVE_V3_SUPPLY_FUSE]] });
    await fuseManager.writeContract({ address: vault, abi: vaultAbi, functionName: "addBalanceFuse", args: [AAVE_V3_MARKET, AAVE_V3_BALANCE_FUSE] });
    await fuseManager.writeContract({ address: vault, abi: vaultAbi, functionName: "addBalanceFuse", args: [ERC20_VAULT_BALANCE_MARKET, ERC20_BALANCE_FUSE] });
    // grantMarketSubstrates replaces the market's whole list. An address substrate is left-padded to 32 bytes.
    const usdcSubstrate = pad(USDC, { size: 32 });
    await fuseManager.writeContract({ address: vault, abi: vaultAbi, functionName: "grantMarketSubstrates", args: [AAVE_V3_MARKET, [usdcSubstrate]] });
    await fuseManager.writeContract({ address: vault, abi: vaultAbi, functionName: "grantMarketSubstrates", args: [ERC20_VAULT_BALANCE_MARKET, [usdcSubstrate]] });
    // The ERC20 balance market values the vault's other tokens. Its fuse skips the underlying asset (USDC here): idle USDC is counted directly in totalAssets.
    // The dependency makes the vault refresh the ERC20 balance market whenever the Aave V3 market balance is updated.
    await fuseManager.writeContract({ address: vault, abi: vaultAbi, functionName: "updateDependencyBalanceGraphs", args: [[AAVE_V3_MARKET], [[ERC20_VAULT_BALANCE_MARKET]]] });

    assert.equal(await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "isFuseSupported", args: [AAVE_V3_SUPPLY_FUSE] }), true);
    assert.equal(await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "isBalanceFuseSupported", args: [AAVE_V3_MARKET, AAVE_V3_BALANCE_FUSE] }), true);
    assert.equal(await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "isBalanceFuseSupported", args: [ERC20_VAULT_BALANCE_MARKET, ERC20_BALANCE_FUSE] }), true);
    assert.equal(await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "isMarketSubstrateGranted", args: [AAVE_V3_MARKET, usdcSubstrate] }), true);
    assert.equal(await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "isMarketSubstrateGranted", args: [ERC20_VAULT_BALANCE_MARKET, usdcSubstrate] }), true);
    assert.deepEqual(await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getDependencyBalanceGraph", args: [AAVE_V3_MARKET] }), [ERC20_VAULT_BALANCE_MARKET]);
  });

  it("05 the Atomist opens deposits to everyone", async () => {
    await atomist.writeContract({ address: vault, abi: vaultAbi, functionName: "convertToPublicVault" });

    for (const signature of ["deposit(uint256,address)", "mint(uint256,address)"]) {
      const role = await publicClient.readContract({ address: accessManager, abi: accessManagerAbi, functionName: "getTargetFunctionRole", args: [vault, toFunctionSelector(signature)] });
      assert.equal(role, PUBLIC_ROLE, signature);
    }
  });
});
