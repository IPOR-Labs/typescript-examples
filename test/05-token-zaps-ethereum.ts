// S5 Token zaps: deposit ETH, wstETH and USDC into vaults whose asset is another token, through the
// deployed zap contract ERC4626ZapInWithNativeToken. The zap runs the calls it is given (wrap, stake,
// unwrap, mint) and deposits the resulting vault asset in the same transaction.
// The vaults are set up as in S1, without a market: the zapped assets stay idle in the vault.
// The values shared by every deposit method (balance, Max, public, paused, maxDeposit, withdraw note)
// are read as in S3. This story adds the values specific to a zap: the expected output, the slippage minimum
// passed as minAmountToDeposit, the approval spender and the native token's USD price.
// Every step is a real transaction on an Ethereum fork, and a step depends on the steps above it.
// The story skips simulation on purpose, to show the transaction flow. A real app on a real
// chain should simulate before each transaction, to check gas usage and whether it reverts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import {
  encodeFunctionData,
  erc20Abi,
  maxUint256,
  parseEther,
  parseEventLogs,
  parseUnits,
  toFunctionSelector,
  zeroAddress,
  type Address,
} from "viem";
import { accessManagerAbi } from "../abis/accessManager.abi.ts";
import { allowanceAbi } from "../abis/allowance.abi.ts";
import { chainlinkAbi } from "../abis/chainlink.abi.ts";
import { creditEnforcerAbi } from "../abis/creditEnforcer.abi.ts";
import { factoryAbi } from "../abis/factory.abi.ts";
import { stEthAbi } from "../abis/stEth.abi.ts";
import { vaultAbi } from "../abis/vault.abi.ts";
import { wethAbi } from "../abis/weth.abi.ts";
import { wstEthAbi } from "../abis/wstEth.abi.ts";
import { zapAbi } from "../abis/zap.abi.ts";

// Ethereum addresses, from ipor-abi: mainnet/mainnet-ethereum-fusion/addresses.json at 9d1a7c7 (factory, zap)
// and ipor-webapp packages/fusion-sdk/src/markets/{weth,lido,reservoir}/*.addresses.ts at 556ca3f5a, 37b9619a2 and 37b9619a2
// (tokens, Reservoir PSM and CreditEnforcer).
const FACTORY = "0xcd05909C4A1F8E501e4ED554cEF4Ed5E48D9b852";
const ZAP = "0x677251190C0cCcC6E7e71C385B3EA660Dfd89c00";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const STETH = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";
const WSTETH = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
// USDC has 6 decimals.
const USDC_DECIMALS = 6;
const RUSD = "0x09D4214C03D01F49544C0448DBE3A27f768F2b34";
const RESERVOIR_PSM = "0x4809010926aec940b550D34a46A52739f996D75D";
const RESERVOIR_CREDIT_ENFORCER = "0x04716DB62C085D9e08050fcF6F7D775A03d07720";
// Chainlink ETH/USD on Ethereum, the feed the IPOR webapp reads for the native token price (ipor-webapp src/usdPrices/types.ts at a1416b1fd).
const CHAINLINK_ETH_USD = "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419";
// Morpho Blue holds wstETH and USDC on Ethereum: the story funds the depositor from it.
const WHALE = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

// Role ID from Roles.sol (ipor-fusion 4fdaf50).
const ATOMIST_ROLE = 100n;
const PUBLIC_ROLE = 2n ** 64n - 1n;

// Hardhat's default accounts.
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ATOMIST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DEPOSITOR = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";

// The default "Max slippage" is 0.5%. Rates and the slippage use 18 decimals.
const WAD_DECIMALS = 18n;
const WAD = 10n ** WAD_DECIMALS;
const SLIPPAGE = parseEther("0.005");

// grantRole: the grant takes effect without an execution delay.
const NO_EXECUTION_DELAY = 0;
const DEPOSIT_SELECTOR = toFunctionSelector("deposit(uint256,address)");

const REDEMPTION_DELAY = 0n;
const DAO_FEE_PACKAGE_INDEX = 0n;
const WETH_VAULT_NAME = "Story WETH";
const WETH_VAULT_SYMBOL = "sWETH";
const STETH_VAULT_NAME = "Story stETH";
const STETH_VAULT_SYMBOL = "sstETH";
const RUSD_VAULT_NAME = "Story rUSD";
const RUSD_VAULT_SYMBOL = "srUSD";

const amount1Eth = parseEther("1");
const amount1WstEth = parseEther("1");
const amount1000Usdc = parseUnits("1000", USDC_DECIMALS);

const NO_NATIVE_TOKEN = 0n;

const { viem, networkHelpers } = await network.create("ethereum");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const depositor = await viem.getWalletClient(DEPOSITOR);

describe("S5 Token zaps on Ethereum: Wrap ETH, Stake ETH, Unwrap wstETH, Mint rUSD", () => {
  let wethVault: Address, stEthVault: Address, rUsdVault: Address;

  it("01 clones a WETH, an stETH and an rUSD vault and opens each to every depositor (see S1)", async () => {
    const wethCloneHash = await owner.writeContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: "clone",
      args: [
        WETH_VAULT_NAME,
        WETH_VAULT_SYMBOL,
        WETH,
        REDEMPTION_DELAY,
        OWNER,
        DAO_FEE_PACKAGE_INDEX,
      ],
    });
    const wethCloneReceipt = await publicClient.waitForTransactionReceipt({ hash: wethCloneHash });
    const [wethCreated] = parseEventLogs({
      abi: factoryAbi,
      logs: wethCloneReceipt.logs,
      eventName: "FusionInstanceCreated",
    });
    assert.ok(wethCreated, "the receipt has no FusionInstanceCreated event");
    wethVault = wethCreated.args.plasmaVault;
    const wethAccessManager = await publicClient.readContract({
      address: wethVault,
      abi: vaultAbi,
      functionName: "getAccessManagerAddress",
    });
    const [wethAtomistHadRole] = await publicClient.readContract({
      address: wethAccessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [ATOMIST_ROLE, ATOMIST],
    });
    assert.equal(wethAtomistHadRole, false);
    // On the access manager: the Owner grants the Atomist role, which unlocks convertToPublicVault and the role grants that follow.
    await owner.writeContract({
      address: wethAccessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [ATOMIST_ROLE, ATOMIST, NO_EXECUTION_DELAY],
    });
    const [[wethAtomistHasRole], wethDepositRoleBefore] = await Promise.all([
      publicClient.readContract({
        address: wethAccessManager,
        abi: accessManagerAbi,
        functionName: "hasRole",
        args: [ATOMIST_ROLE, ATOMIST],
      }),
      publicClient.readContract({
        address: wethAccessManager,
        abi: accessManagerAbi,
        functionName: "getTargetFunctionRole",
        args: [wethVault, DEPOSIT_SELECTOR],
      }),
    ]);
    assert.equal(wethAtomistHasRole, true);
    assert.notEqual(wethDepositRoleBefore, PUBLIC_ROLE);
    await atomist.writeContract({
      address: wethVault,
      abi: vaultAbi,
      functionName: "convertToPublicVault",
    });
    const wethDepositRole = await publicClient.readContract({
      address: wethAccessManager,
      abi: accessManagerAbi,
      functionName: "getTargetFunctionRole",
      args: [wethVault, DEPOSIT_SELECTOR],
    });
    assert.equal(wethDepositRole, PUBLIC_ROLE);

    const stEthCloneHash = await owner.writeContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: "clone",
      args: [
        STETH_VAULT_NAME,
        STETH_VAULT_SYMBOL,
        STETH,
        REDEMPTION_DELAY,
        OWNER,
        DAO_FEE_PACKAGE_INDEX,
      ],
    });
    const stEthCloneReceipt = await publicClient.waitForTransactionReceipt({ hash: stEthCloneHash });
    const [stEthCreated] = parseEventLogs({
      abi: factoryAbi,
      logs: stEthCloneReceipt.logs,
      eventName: "FusionInstanceCreated",
    });
    assert.ok(stEthCreated, "the receipt has no FusionInstanceCreated event");
    stEthVault = stEthCreated.args.plasmaVault;
    const stEthAccessManager = await publicClient.readContract({
      address: stEthVault,
      abi: vaultAbi,
      functionName: "getAccessManagerAddress",
    });
    const [stEthAtomistHadRole] = await publicClient.readContract({
      address: stEthAccessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [ATOMIST_ROLE, ATOMIST],
    });
    assert.equal(stEthAtomistHadRole, false);
    // On the access manager: the Owner grants the Atomist role, which unlocks convertToPublicVault and the role grants that follow.
    await owner.writeContract({
      address: stEthAccessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [ATOMIST_ROLE, ATOMIST, NO_EXECUTION_DELAY],
    });
    const [[stEthAtomistHasRole], stEthDepositRoleBefore] = await Promise.all([
      publicClient.readContract({
        address: stEthAccessManager,
        abi: accessManagerAbi,
        functionName: "hasRole",
        args: [ATOMIST_ROLE, ATOMIST],
      }),
      publicClient.readContract({
        address: stEthAccessManager,
        abi: accessManagerAbi,
        functionName: "getTargetFunctionRole",
        args: [stEthVault, DEPOSIT_SELECTOR],
      }),
    ]);
    assert.equal(stEthAtomistHasRole, true);
    assert.notEqual(stEthDepositRoleBefore, PUBLIC_ROLE);
    await atomist.writeContract({
      address: stEthVault,
      abi: vaultAbi,
      functionName: "convertToPublicVault",
    });
    const stEthDepositRole = await publicClient.readContract({
      address: stEthAccessManager,
      abi: accessManagerAbi,
      functionName: "getTargetFunctionRole",
      args: [stEthVault, DEPOSIT_SELECTOR],
    });
    assert.equal(stEthDepositRole, PUBLIC_ROLE);

    const rUsdCloneHash = await owner.writeContract({
      address: FACTORY,
      abi: factoryAbi,
      functionName: "clone",
      args: [
        RUSD_VAULT_NAME,
        RUSD_VAULT_SYMBOL,
        RUSD,
        REDEMPTION_DELAY,
        OWNER,
        DAO_FEE_PACKAGE_INDEX,
      ],
    });
    const rUsdCloneReceipt = await publicClient.waitForTransactionReceipt({ hash: rUsdCloneHash });
    const [rUsdCreated] = parseEventLogs({
      abi: factoryAbi,
      logs: rUsdCloneReceipt.logs,
      eventName: "FusionInstanceCreated",
    });
    assert.ok(rUsdCreated, "the receipt has no FusionInstanceCreated event");
    rUsdVault = rUsdCreated.args.plasmaVault;
    const rUsdAccessManager = await publicClient.readContract({
      address: rUsdVault,
      abi: vaultAbi,
      functionName: "getAccessManagerAddress",
    });
    const [rUsdAtomistHadRole] = await publicClient.readContract({
      address: rUsdAccessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [ATOMIST_ROLE, ATOMIST],
    });
    assert.equal(rUsdAtomistHadRole, false);
    // On the access manager: the Owner grants the Atomist role, which unlocks convertToPublicVault and the role grants that follow.
    await owner.writeContract({
      address: rUsdAccessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [ATOMIST_ROLE, ATOMIST, NO_EXECUTION_DELAY],
    });
    const [[rUsdAtomistHasRole], rUsdDepositRoleBefore] = await Promise.all([
      publicClient.readContract({
        address: rUsdAccessManager,
        abi: accessManagerAbi,
        functionName: "hasRole",
        args: [ATOMIST_ROLE, ATOMIST],
      }),
      publicClient.readContract({
        address: rUsdAccessManager,
        abi: accessManagerAbi,
        functionName: "getTargetFunctionRole",
        args: [rUsdVault, DEPOSIT_SELECTOR],
      }),
    ]);
    assert.equal(rUsdAtomistHasRole, true);
    assert.notEqual(rUsdDepositRoleBefore, PUBLIC_ROLE);
    await atomist.writeContract({
      address: rUsdVault,
      abi: vaultAbi,
      functionName: "convertToPublicVault",
    });
    const rUsdDepositRole = await publicClient.readContract({
      address: rUsdAccessManager,
      abi: accessManagerAbi,
      functionName: "getTargetFunctionRole",
      args: [rUsdVault, DEPOSIT_SELECTOR],
    });
    assert.equal(rUsdDepositRole, PUBLIC_ROLE);

    const [wethVaultAssets, stEthVaultAssets, rUsdVaultAssets] = await Promise.all([
      publicClient.readContract({
        address: wethVault,
        abi: vaultAbi,
        functionName: "totalAssets",
      }),
      publicClient.readContract({
        address: stEthVault,
        abi: vaultAbi,
        functionName: "totalAssets",
      }),
      publicClient.readContract({
        address: rUsdVault,
        abi: vaultAbi,
        functionName: "totalAssets",
      }),
    ]);
    assert.equal(wethVaultAssets, 0n);
    assert.equal(stEthVaultAssets, 0n);
    assert.equal(rUsdVaultAssets, 0n);
  });

  it("02 reads the native ETH price from Chainlink, as a client prices an ETH amount", async () => {
    const [[, answer], decimals] = await Promise.all([
      publicClient.readContract({
        address: CHAINLINK_ETH_USD,
        abi: chainlinkAbi,
        functionName: "latestRoundData",
      }),
      publicClient.readContract({
        address: CHAINLINK_ETH_USD,
        abi: chainlinkAbi,
        functionName: "decimals",
      }),
    ]);
    assert.ok(answer > 0n, "the ETH/USD answer is not positive");
    // A client scales the 8-decimal answer to 18 decimals, then prices the amount: 1 ETH in USD, 18 decimals.
    const ethUsd18 = answer * 10n ** (WAD_DECIMALS - BigInt(decimals));
    const oneEthUsd = (parseEther("1") * ethUsd18) / WAD;
    assert.ok(
      oneEthUsd > parseEther("500") && oneEthUsd < parseEther("20000"),
      `1 ETH is between 500 and 20000 USD, got ${oneEthUsd} / 1e18`,
    );
  });

  it("03 Wrap ETH: the zap wraps ETH into WETH and deposits it into the WETH vault", async () => {
    // Wrap ETH has a 1:1 rate and no slippage option: the minimum is the exact expected output.
    const expected = amount1Eth;
    const minimum = expected;
    // ETH is sent as the transaction value, so there is no approval. The zap deposits its whole WETH balance,
    // which must reach minAmountToDeposit.
    assert.equal(await publicClient.readContract({
      address: wethVault,
      abi: vaultAbi,
      functionName: "totalAssets",
    }), 0n);
    await depositor.writeContract({
      address: ZAP, abi: zapAbi, functionName: "zapIn", value: amount1Eth,
      args: [{ vault: wethVault, receiver: DEPOSITOR, minAmountToDeposit: minimum, assetsToRefundToSender: [], calls: [
        {
          target: WETH,
          data: encodeFunctionData({ abi: wethAbi, functionName: "deposit" }),
          nativeTokenAmount: amount1Eth,
        },
        {
          target: WETH,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [wethVault, maxUint256] }),
          nativeTokenAmount: NO_NATIVE_TOKEN,
        },
      ] }],
    });
    const [wethTotalAssets, wethDepositorAssetsShares] = await Promise.all([
      publicClient.readContract({
        address: wethVault,
        abi: vaultAbi,
        functionName: "totalAssets",
      }),
      publicClient.readContract({
        address: wethVault,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
    ]);
    assert.ok(wethTotalAssets >= minimum);
    const wethDepositorAssets = await publicClient.readContract({
      address: wethVault,
      abi: vaultAbi,
      functionName: "convertToAssets",
      args: [wethDepositorAssetsShares],
    });
    assert.ok(wethDepositorAssets >= minimum);
  });

  it("04 Stake ETH: the zap stakes ETH with Lido and deposits the stETH into the stETH vault", async () => {
    // Lido mints stETH 1:1 for ETH, but stETH balances round down by 1 to 2 wei: the minimum is 0.5% below.
    const expected = amount1Eth;
    const minimum = (expected * (WAD - SLIPPAGE)) / WAD;
    assert.equal(await publicClient.readContract({
      address: stEthVault,
      abi: vaultAbi,
      functionName: "totalAssets",
    }), 0n);
    await depositor.writeContract({
      address: ZAP, abi: zapAbi, functionName: "zapIn", value: amount1Eth,
      args: [{ vault: stEthVault, receiver: DEPOSITOR, minAmountToDeposit: minimum, assetsToRefundToSender: [], calls: [
        {
          target: STETH,
          data: encodeFunctionData({ abi: stEthAbi, functionName: "submit", args: [zeroAddress] }),
          nativeTokenAmount: amount1Eth,
        },
        {
          target: STETH,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [stEthVault, maxUint256] }),
          nativeTokenAmount: NO_NATIVE_TOKEN,
        },
      ] }],
    });
    const [stEthTotalAssets, stEthDepositorAssetsShares] = await Promise.all([
      publicClient.readContract({
        address: stEthVault,
        abi: vaultAbi,
        functionName: "totalAssets",
      }),
      publicClient.readContract({
        address: stEthVault,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
    ]);
    assert.ok(stEthTotalAssets >= minimum);
    const stEthDepositorAssets = await publicClient.readContract({
      address: stEthVault,
      abi: vaultAbi,
      functionName: "convertToAssets",
      args: [stEthDepositorAssetsShares],
    });
    assert.ok(stEthDepositorAssets >= minimum);
  });

  it("05 Unwrap wstETH: the depositor approves the zap's allowance contract, and the zap unwraps into the stETH vault", async () => {
    // Unlocks the Morpho Blue address so the story can send its wstETH from it without its key.
    await networkHelpers.impersonateAccount(WHALE);
    // Gives the whale ETH to pay gas for its wstETH transfer.
    await networkHelpers.setBalance(WHALE, parseEther("1"));
    const whale = await viem.getWalletClient(WHALE);
    const depositorWstEthBefore = await publicClient.readContract({
      address: WSTETH,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    });
    await whale.writeContract({
      address: WSTETH,
      abi: erc20Abi,
      functionName: "transfer",
      args: [DEPOSITOR, amount1WstEth],
    });
    const depositorWstEth = await publicClient.readContract({
      address: WSTETH,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    });
    assert.equal(depositorWstEth - depositorWstEthBefore, amount1WstEth);

    // The approval spender is not the zap itself: it is the allowance contract the zap names.
    const allowanceContract = await publicClient.readContract({
      address: ZAP,
      abi: zapAbi,
      functionName: "ZAP_IN_ALLOWANCE_CONTRACT",
    });
    assert.equal(await publicClient.readContract({
      address: WSTETH,
      abi: erc20Abi,
      functionName: "allowance",
      args: [DEPOSITOR, allowanceContract],
    }), 0n);
    await depositor.writeContract({
      address: WSTETH,
      abi: erc20Abi,
      functionName: "approve",
      args: [allowanceContract, amount1WstEth],
    });
    assert.equal(await publicClient.readContract({
      address: WSTETH,
      abi: erc20Abi,
      functionName: "allowance",
      args: [DEPOSITOR, allowanceContract],
    }), amount1WstEth);

    // Expected output: amount * rate / 10^18, with the rate from stEthPerToken(). The minimum is 0.5% below.
    const rate = await publicClient.readContract({
      address: WSTETH,
      abi: wstEthAbi,
      functionName: "stEthPerToken",
    });
    const expected = (amount1WstEth * rate) / WAD;
    const minimum = (expected * (WAD - SLIPPAGE)) / WAD;
    const [before, depositorBeforeShares] = await Promise.all([
      publicClient.readContract({
        address: stEthVault,
        abi: vaultAbi,
        functionName: "totalAssets",
      }),
      publicClient.readContract({
        address: stEthVault,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
    ]);
    const depositorBefore = await publicClient.readContract({
      address: stEthVault,
      abi: vaultAbi,
      functionName: "convertToAssets",
      args: [depositorBeforeShares],
    });
    await depositor.writeContract({
      address: ZAP, abi: zapAbi, functionName: "zapIn",
      args: [{ vault: stEthVault, receiver: DEPOSITOR, minAmountToDeposit: minimum, assetsToRefundToSender: [], calls: [
        {
          target: allowanceContract,
          data: encodeFunctionData({
            abi: allowanceAbi,
            functionName: "transferApprovedAssets",
            args: [WSTETH, amount1WstEth],
          }),
          nativeTokenAmount: NO_NATIVE_TOKEN,
        },
        {
          target: WSTETH,
          data: encodeFunctionData({ abi: wstEthAbi, functionName: "unwrap", args: [amount1WstEth] }),
          nativeTokenAmount: NO_NATIVE_TOKEN,
        },
        {
          target: STETH,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [stEthVault, maxUint256] }),
          nativeTokenAmount: NO_NATIVE_TOKEN,
        },
      ] }],
    });

    const [stEthTotalAssets, stEthDepositorAssetsShares] = await Promise.all([
      publicClient.readContract({
        address: stEthVault,
        abi: vaultAbi,
        functionName: "totalAssets",
      }),
      publicClient.readContract({
        address: stEthVault,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
    ]);
    assert.ok(stEthTotalAssets - before >= minimum);
    const stEthDepositorAssets = await publicClient.readContract({
      address: stEthVault,
      abi: vaultAbi,
      functionName: "convertToAssets",
      args: [stEthDepositorAssetsShares],
    });
    assert.ok(stEthDepositorAssets - depositorBefore >= minimum);
  });

  it("06 Mint rUSD: the zap mints rUSD from USDC through Reservoir and deposits it into the rUSD vault", async () => {
    const whale = await viem.getWalletClient(WHALE);
    const depositorUsdcBefore = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    });
    await whale.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "transfer",
      args: [DEPOSITOR, amount1000Usdc],
    });
    const [depositorUsdc, allowanceContract] = await Promise.all([
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
      publicClient.readContract({
        address: ZAP,
        abi: zapAbi,
        functionName: "ZAP_IN_ALLOWANCE_CONTRACT",
      }),
    ]);
    assert.equal(depositorUsdc - depositorUsdcBefore, amount1000Usdc);
    assert.equal(await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [DEPOSITOR, allowanceContract],
    }), 0n);
    await depositor.writeContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "approve",
      args: [allowanceContract, amount1000Usdc],
    });
    assert.equal(await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "allowance",
      args: [DEPOSITOR, allowanceContract],
    }), amount1000Usdc);

    // Expected output: amount * 1e18 rate / 10^6 USDC decimals, so rUSD in 18 decimals. The minimum is 0.5% below.
    const expected = (amount1000Usdc * WAD) / 10n ** BigInt(USDC_DECIMALS);
    const minimum = (expected * (WAD - SLIPPAGE)) / WAD;
    assert.equal(await publicClient.readContract({
      address: rUsdVault,
      abi: vaultAbi,
      functionName: "totalAssets",
    }), 0n);
    // The zap approves the PSM, pulls the USDC, and CreditEnforcer mints rUSD 1:1 through the PSM.
    await depositor.writeContract({
      address: ZAP, abi: zapAbi, functionName: "zapIn",
      args: [{ vault: rUsdVault, receiver: DEPOSITOR, minAmountToDeposit: minimum, assetsToRefundToSender: [], calls: [
        {
          target: USDC,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [RESERVOIR_PSM, amount1000Usdc] }),
          nativeTokenAmount: NO_NATIVE_TOKEN,
        },
        {
          target: allowanceContract,
          data: encodeFunctionData({
            abi: allowanceAbi,
            functionName: "transferApprovedAssets",
            args: [USDC, amount1000Usdc],
          }),
          nativeTokenAmount: NO_NATIVE_TOKEN,
        },
        {
          target: RESERVOIR_CREDIT_ENFORCER,
          data: encodeFunctionData({ abi: creditEnforcerAbi, functionName: "mintStablecoin", args: [amount1000Usdc] }),
          nativeTokenAmount: NO_NATIVE_TOKEN,
        },
        {
          target: RUSD,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [rUsdVault, maxUint256] }),
          nativeTokenAmount: NO_NATIVE_TOKEN,
        },
      ] }],
    });
    const [rUsdTotalAssets, rUsdDepositorAssetsShares] = await Promise.all([
      publicClient.readContract({
        address: rUsdVault,
        abi: vaultAbi,
        functionName: "totalAssets",
      }),
      publicClient.readContract({
        address: rUsdVault,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
    ]);
    assert.ok(rUsdTotalAssets >= minimum);
    const rUsdDepositorAssets = await publicClient.readContract({
      address: rUsdVault,
      abi: vaultAbi,
      functionName: "convertToAssets",
      args: [rUsdDepositorAssetsShares],
    });
    assert.ok(rUsdDepositorAssets >= minimum);
  });
});
