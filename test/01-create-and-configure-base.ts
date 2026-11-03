// S1 Create and configure: clone a Plasma Vault from the factory, set up its roles,
// install the Aave V3 Lend market and open the vault to every depositor.
// This is the first story. Every later story starts from a vault built this way.
// Every step is a real transaction on a Base fork, and a step depends on the steps above it.
// The story skips simulation on purpose, to show the transaction flow. A real app on a real
// chain should simulate before each transaction, to check gas usage and whether it reverts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { parseEventLogs, pad, toFunctionSelector, isAddressEqual, zeroAddress, type Address } from "viem";
import { accessManagerAbi } from "../abis/accessManager.abi.ts";
import { factoryAbi } from "../abis/factory.abi.ts";
import { vaultAbi } from "../abis/vault.abi.ts";

// Base addresses, from ipor-abi: mainnet/mainnet-base-fusion/addresses.json at 8b1be92 (factory, Aave V3 fuses),
// mainnet/addresses.json at e228075 (BalanceFuseErc20) and README.md (USDC).
const FACTORY = "0x1455717668fA96534f675856347A973fA907e922";
const AAVE_V3_SUPPLY_FUSE = "0x26fD6EF391E98C78CfCA27e00c3d15be4D941625";
const AAVE_V3_BALANCE_FUSE = "0x952573Ec1B6895a88a95CA523097083d4da4D8e5";
const ERC20_BALANCE_FUSE = "0x9ba147FC382DBf4D73512A45370ba0B70c25F6aa";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const VAULT_NAME = "Story USDC";
const VAULT_SYMBOL = "sUSDC";
const REDEMPTION_DELAY = 0n;
const DAO_FEE_PACKAGE_INDEX = 0n;
// The factory installs this fuse on every clone. From ipor-abi: mainnet/mainnet-base-fusion/addresses.json (BurnRequestFeeFuseV2).
const BURN_REQUEST_FEE_FUSE = "0x7f80241a2b8dA1e11b96B5749991e9A9a40b62a9";

// Market IDs from IporFusionMarkets.sol (ipor-fusion 004d054) and role IDs from Roles.sol (ipor-fusion 4fdaf50).
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

// grantRole: the grant takes effect without an execution delay.
const NO_EXECUTION_DELAY = 0;
const DEPOSIT_SELECTOR = toFunctionSelector("deposit(uint256,address)");

const { viem } = await network.create("base");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const fuseManager = await viem.getWalletClient(FUSE_MANAGER);

describe("S1 Create and configure a USDC vault on Aave V3", () => {
  let vault: Address, accessManager: Address;

  it("01 clones a vault from the factory and reads the created addresses from the receipt", async () => {
    // Arguments: share name and symbol, underlying token, redemption delay, owner, DAO fee package.
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

    assert.notEqual(vault, zeroAddress);
    assert.notEqual(created.args.feeManager, zeroAddress);
    assert.ok(isAddressEqual(await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "asset",
    }), USDC));
    const [ownerHasRole] = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [OWNER_ROLE, OWNER],
    });
    assert.equal(ownerHasRole, true);
  });

  it("02 the owner grants Atomist, and only Atomist", async () => {
    const [atomistHadRole] = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [ATOMIST_ROLE, ATOMIST],
    });
    assert.equal(atomistHadRole, false);
    // On the access manager: the Owner grants the Atomist role, which unlocks role grants and convertToPublicVault on the vault.
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
    await assert.rejects(
      // Expected to revert: only the Atomist may grant Alpha, not the Owner.
      owner.writeContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "grantRole",
        args: [ALPHA_ROLE, ALPHA, NO_EXECUTION_DELAY],
      }),
      /AccessManagerUnauthorizedAccount/,
    );
  });

  it("03 the Atomist grants Fuse Manager and Alpha", async () => {
    const [[fuseManagerHadRole], [alphaHadRole]] = await Promise.all([
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
    assert.equal(fuseManagerHadRole, false);
    assert.equal(alphaHadRole, false);
    // On the access manager: Fuse Manager unlocks addFuses and grantMarketSubstrates on the vault.
    await atomist.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [FUSE_MANAGER_ROLE, FUSE_MANAGER, NO_EXECUTION_DELAY],
    });
    // On the access manager: Alpha unlocks execute on the vault.
    await atomist.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [ALPHA_ROLE, ALPHA, NO_EXECUTION_DELAY],
    });

    const [[fuseManagerHasRole], [alphaHasRole]] = await Promise.all([
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
    assert.equal(fuseManagerHasRole, true);
    assert.equal(alphaHasRole, true);
  });

  it("04 the Fuse Manager installs Aave V3: fuse, balance fuses, substrates, then the dependency", async () => {
    // grantMarketSubstrates replaces the market's whole list. An address substrate is left-padded to 32 bytes.
    const usdcSubstrate = pad(USDC, { size: 32 });
    const fusesBefore = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "getFuses",
    });
    assert.deepEqual(fusesBefore, [BURN_REQUEST_FEE_FUSE]);
    const [
      aaveV3SupplyFuseSupportedBefore,
      aaveV3BalanceFuseSupportedBefore,
      erc20BalanceFuseSupportedBefore,
      aaveV3MarketUsdcSubstrateGrantedBefore,
      erc20VaultBalanceMarketUsdcSubstrateGrantedBefore,
      aaveV3MarketDependencyBalanceGraphBefore,
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
    ]);
    assert.equal(aaveV3SupplyFuseSupportedBefore, false);
    assert.equal(aaveV3BalanceFuseSupportedBefore, false);
    assert.equal(erc20BalanceFuseSupportedBefore, false);
    assert.equal(aaveV3MarketUsdcSubstrateGrantedBefore, false);
    assert.equal(erc20VaultBalanceMarketUsdcSubstrateGrantedBefore, false);
    assert.deepEqual(aaveV3MarketDependencyBalanceGraphBefore, []);

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
    // The ERC20 balance market values the vault's other tokens. Its fuse skips the underlying asset (USDC here): idle USDC is counted directly in totalAssets.
    // The dependency makes the vault refresh the ERC20 balance market whenever the Aave V3 market balance is updated.
    await fuseManager.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "updateDependencyBalanceGraphs",
      args: [[AAVE_V3_MARKET], [[ERC20_VAULT_BALANCE_MARKET]]],
    });

    const [
      fuses,
      aaveV3SupplyFuseSupported,
      aaveV3BalanceFuseSupported,
      erc20BalanceFuseSupported,
      aaveV3MarketUsdcSubstrateGranted,
      erc20VaultBalanceMarketUsdcSubstrateGranted,
      aaveV3MarketDependencyBalanceGraph,
    ] = await Promise.all([
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "getFuses",
      }),
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
    ]);
    assert.deepEqual(fuses, [...fusesBefore, AAVE_V3_SUPPLY_FUSE]);
    assert.equal(aaveV3SupplyFuseSupported, true);
    assert.equal(aaveV3BalanceFuseSupported, true);
    assert.equal(erc20BalanceFuseSupported, true);
    assert.equal(aaveV3MarketUsdcSubstrateGranted, true);
    assert.equal(erc20VaultBalanceMarketUsdcSubstrateGranted, true);
    assert.deepEqual(aaveV3MarketDependencyBalanceGraph, [ERC20_VAULT_BALANCE_MARKET]);
  });

  it("05 the Atomist opens deposits to everyone", async () => {
    const depositRoleBefore = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "getTargetFunctionRole",
      args: [vault, DEPOSIT_SELECTOR],
    });
    assert.notEqual(depositRoleBefore, PUBLIC_ROLE);
    await atomist.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "convertToPublicVault",
    });

    for (const signature of ["deposit(uint256,address)", "mint(uint256,address)"]) {
      const role = await publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "getTargetFunctionRole",
        args: [vault, toFunctionSelector(signature)],
      });
      assert.equal(role, PUBLIC_ROLE, signature);
    }
  });
});
