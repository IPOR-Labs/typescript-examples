// S6 Aggregator zap on Ethereum: swap WETH into a USDC vault in one zap transaction, from a recorded
// KyberSwap route and a recorded Velora route, then derive the numbers a deposit previews.
// It stands alone: step 01 repeats S1's setup in short, without a market. The values every deposit shares are in S3.
// Every step is a real transaction on an Ethereum fork, and a step depends on the steps above it.
// The routes are replayed from test/fixtures/, recorded at the fork block by scripts/record-zap-fixture.ts:
// a live aggregator quote goes stale against a pinned fork.
// The story skips simulation on purpose, to show the transaction flow. A real app on a real
// chain should simulate before each transaction, to check gas usage and whether it reverts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { network } from "hardhat";
import {
  encodeFunctionData,
  erc20Abi,
  maxUint256,
  parseEther,
  parseEventLogs,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { previewValues } from "../helpers/aggregator-zap-preview.ts";
import { accessManagerAbi } from "../abis/accessManager.abi.ts";
import { allowanceAbi } from "../abis/allowance.abi.ts";
import { factoryAbi } from "../abis/factory.abi.ts";
import { priceOracleAbi } from "../abis/priceOracle.abi.ts";
import { vaultAbi } from "../abis/vault.abi.ts";
import { wethAbi } from "../abis/weth.abi.ts";
import { zapAbi } from "../abis/zap.abi.ts";

// Ethereum addresses, from ipor-abi: mainnet/mainnet-ethereum-fusion/addresses.json at 9d1a7c7 (factory, zap)
// and README.md (USDC, WETH).
const FACTORY = "0xcd05909C4A1F8E501e4ED554cEF4Ed5E48D9b852";
const ZAP = "0x677251190C0cCcC6E7e71C385B3EA660Dfd89c00";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const VAULT_NAME = "Story USDC";
const VAULT_SYMBOL = "sUSDC";
const REDEMPTION_DELAY = 0n;
const DAO_FEE_PACKAGE_INDEX = 0n;
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

// Role IDs from Roles.sol (ipor-fusion 4fdaf50).
const ATOMIST_ROLE = 100n;
const PUBLIC_ROLE = 2n ** 64n - 1n;

// Hardhat's default accounts, one per role.
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const ATOMIST = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const DEPOSITOR = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";

// The fixture shape scripts/record-zap-fixture.ts writes. The route was built with the zap as sender and recipient.
type Fixture = {
  aggregator: string;
  block: number;
  pair: { tokenIn: Address; tokenOut: Address };
  amountIn: string;
  quotedOut: string;
  minOut: string;
  router: { target: Address; approvalProxy: Address };
  calldata: Hex;
};
const kyberswap: Fixture = JSON.parse(
  readFileSync(new URL("fixtures/kyberswap-ethereum-0.1-weth-to-usdc-26330265.json", import.meta.url), "utf8"),
);
const velora: Fixture = JSON.parse(
  readFileSync(new URL("fixtures/velora-ethereum-0.1-weth-to-usdc-26330265.json", import.meta.url), "utf8"),
);

// grantRole: the grant takes effect without an execution delay.
const NO_EXECUTION_DELAY = 0;
const DEPOSIT_SELECTOR = toFunctionSelector("deposit(uint256,address)");
const NO_ALLOWANCE = 0n;

const NO_NATIVE_TOKEN = 0n;

// Matches the fixture amountIn.
const WRAP_AMOUNT = parseEther("0.2");

const { viem } = await network.create("ethereum");
const publicClient = await viem.getPublicClient();
const owner = await viem.getWalletClient(OWNER);
const atomist = await viem.getWalletClient(ATOMIST);
const depositor = await viem.getWalletClient(DEPOSITOR);

describe("S6 Aggregator zap of WETH into a USDC vault on Ethereum", () => {
  let vault: Address;

  it("01 clones a USDC vault, grants the Atomist and opens deposits to everyone, as in S1", async () => {
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
    const accessManager = await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "getAccessManagerAddress",
    });
    const [atomistHadRole] = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "hasRole",
      args: [ATOMIST_ROLE, ATOMIST],
    });
    assert.equal(atomistHadRole, false);
    // On the access manager: the Owner grants the Atomist role, which unlocks convertToPublicVault and the role grants that follow.
    await owner.writeContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "grantRole",
      args: [ATOMIST_ROLE, ATOMIST, NO_EXECUTION_DELAY],
    });
    const [[atomistHasRole], depositRoleBefore] = await Promise.all([
      publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "hasRole",
        args: [ATOMIST_ROLE, ATOMIST],
      }),
      publicClient.readContract({
        address: accessManager,
        abi: accessManagerAbi,
        functionName: "getTargetFunctionRole",
        args: [vault, DEPOSIT_SELECTOR],
      }),
    ]);
    assert.equal(atomistHasRole, true);
    assert.notEqual(depositRoleBefore, PUBLIC_ROLE);
    await atomist.writeContract({
      address: vault,
      abi: vaultAbi,
      functionName: "convertToPublicVault",
    });
    const depositRole = await publicClient.readContract({
      address: accessManager,
      abi: accessManagerAbi,
      functionName: "getTargetFunctionRole",
      args: [vault, DEPOSIT_SELECTOR],
    });
    assert.equal(depositRole, PUBLIC_ROLE);

    assert.equal(kyberswap.block, velora.block, "both Ethereum fixtures are quoted at the fork block");
  });

  it("02 the depositor wraps 0.2 ETH into WETH, the token both zaps spend", async () => {
    const wethBalanceBefore = await publicClient.readContract({
      address: WETH,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    });
    await depositor.writeContract({
      address: WETH,
      abi: wethAbi,
      functionName: "deposit",
      value: WRAP_AMOUNT,
    });

    const wethBalance = await publicClient.readContract({
      address: WETH,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    });
    assert.equal(wethBalance - wethBalanceBefore, BigInt(kyberswap.amountIn) + BigInt(velora.amountIn));
  });

  it("03 zaps 0.1 WETH into the vault through the recorded KyberSwap route", async () => {
    // One zap transaction: the zap pulls the WETH, swaps it through the router and deposits the USDC for the depositor.
    const kyberswapAmountInWeth = BigInt(kyberswap.amountIn);
    const minAmountToDeposit = BigInt(kyberswap.minOut);
    const proxy = kyberswap.router.approvalProxy;
    // The depositor approves the zap's allowance contract, not the zap itself.
    const allowanceContract = await publicClient.readContract({
      address: ZAP,
      abi: zapAbi,
      functionName: "ZAP_IN_ALLOWANCE_CONTRACT",
    });
    const depositorAllowanceWethBefore = await publicClient.readContract({
      address: WETH,
      abi: erc20Abi,
      functionName: "allowance",
      args: [DEPOSITOR, allowanceContract],
    });
    assert.equal(depositorAllowanceWethBefore, 0n);
    await depositor.writeContract({
      address: WETH,
      abi: erc20Abi,
      functionName: "approve",
      args: [allowanceContract, kyberswapAmountInWeth],
    });
    const depositorAllowanceWethAfter = await publicClient.readContract({
      address: WETH,
      abi: erc20Abi,
      functionName: "allowance",
      args: [DEPOSITOR, allowanceContract],
    });
    assert.equal(depositorAllowanceWethAfter, kyberswapAmountInWeth);

    const [wethBefore, usdcBefore, sharesBefore] = await Promise.all([
      publicClient.readContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vault],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
    ]);
    await depositor.writeContract({
      address: ZAP,
      abi: zapAbi,
      functionName: "zapIn",
      args: [{
        vault,
        receiver: DEPOSITOR,
        // The zap reverts when it would deposit less: the route's quoted output less 50 bps slippage.
        minAmountToDeposit,
        // WETH the router leaves unspent goes back to the depositor.
        assetsToRefundToSender: [WETH],
        calls: [
          {
            target: allowanceContract,
            data: encodeFunctionData({
              abi: allowanceAbi,
              functionName: "transferApprovedAssets",
              args: [WETH, kyberswapAmountInWeth],
            }),
            nativeTokenAmount: NO_NATIVE_TOKEN,
          },
          // Reset to 0 first, as a client does for every token: USDT reverts on a non-zero to non-zero approve.
          {
            target: WETH,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [proxy, NO_ALLOWANCE] }),
            nativeTokenAmount: NO_NATIVE_TOKEN,
          },
          {
            target: WETH,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [proxy, kyberswapAmountInWeth] }),
            nativeTokenAmount: NO_NATIVE_TOKEN,
          },
          {
            target: kyberswap.router.target,
            data: kyberswap.calldata,
            nativeTokenAmount: NO_NATIVE_TOKEN,
          },
          {
            target: USDC,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [vault, maxUint256] }),
            nativeTokenAmount: NO_NATIVE_TOKEN,
          },
        ],
      }],
    });

    const wethBalance = await publicClient.readContract({
      address: WETH,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    });
    const youDeposit = wethBefore - wethBalance;
    const usdcBalance = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [vault],
    });
    const youReceive = usdcBalance - usdcBefore;
    const shares = (await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    })) - sharesBefore;
    // Assert against the minimum, never the quote: the route may pay anything between the two.
    assert.ok(
      youReceive >= minAmountToDeposit,
      `${kyberswap.aggregator}: vault received ${youReceive} USDC units, minimum ${minAmountToDeposit}`,
    );
    assert.ok(shares > 0n, `${kyberswap.aggregator}: no shares minted`);
    await previewValues({ publicClient, vault, wethAddress: WETH, usdcAddress: USDC, youDeposit, youReceive });
  });

  it("04 zaps 0.1 WETH into the vault through the recorded Velora route", async () => {
    // One zap transaction: the zap pulls the WETH, swaps it through the router and deposits the USDC for the depositor.
    const veloraAmountInWeth = BigInt(velora.amountIn);
    const minAmountToDeposit = BigInt(velora.minOut);
    const proxy = velora.router.approvalProxy;
    // The depositor approves the zap's allowance contract, not the zap itself.
    const allowanceContract = await publicClient.readContract({
      address: ZAP,
      abi: zapAbi,
      functionName: "ZAP_IN_ALLOWANCE_CONTRACT",
    });
    const depositorAllowanceWethBefore = await publicClient.readContract({
      address: WETH,
      abi: erc20Abi,
      functionName: "allowance",
      args: [DEPOSITOR, allowanceContract],
    });
    assert.equal(depositorAllowanceWethBefore, 0n);
    await depositor.writeContract({
      address: WETH,
      abi: erc20Abi,
      functionName: "approve",
      args: [allowanceContract, veloraAmountInWeth],
    });
    const depositorAllowanceWethAfter = await publicClient.readContract({
      address: WETH,
      abi: erc20Abi,
      functionName: "allowance",
      args: [DEPOSITOR, allowanceContract],
    });
    assert.equal(depositorAllowanceWethAfter, veloraAmountInWeth);

    const [wethBefore, usdcBefore, sharesBefore] = await Promise.all([
      publicClient.readContract({
        address: WETH,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
      publicClient.readContract({
        address: USDC,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [vault],
      }),
      publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName: "balanceOf",
        args: [DEPOSITOR],
      }),
    ]);
    await depositor.writeContract({
      address: ZAP,
      abi: zapAbi,
      functionName: "zapIn",
      args: [{
        vault,
        receiver: DEPOSITOR,
        // The zap reverts when it would deposit less: the route's quoted output less 50 bps slippage.
        minAmountToDeposit,
        // WETH the router leaves unspent goes back to the depositor.
        assetsToRefundToSender: [WETH],
        calls: [
          {
            target: allowanceContract,
            data: encodeFunctionData({
              abi: allowanceAbi,
              functionName: "transferApprovedAssets",
              args: [WETH, veloraAmountInWeth],
            }),
            nativeTokenAmount: NO_NATIVE_TOKEN,
          },
          // Reset to 0 first, as a client does for every token: USDT reverts on a non-zero to non-zero approve.
          {
            target: WETH,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [proxy, NO_ALLOWANCE] }),
            nativeTokenAmount: NO_NATIVE_TOKEN,
          },
          {
            target: WETH,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [proxy, veloraAmountInWeth] }),
            nativeTokenAmount: NO_NATIVE_TOKEN,
          },
          {
            target: velora.router.target,
            data: velora.calldata,
            nativeTokenAmount: NO_NATIVE_TOKEN,
          },
          {
            target: USDC,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [vault, maxUint256] }),
            nativeTokenAmount: NO_NATIVE_TOKEN,
          },
        ],
      }],
    });

    const wethBalance = await publicClient.readContract({
      address: WETH,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    });
    const youDeposit = wethBefore - wethBalance;
    const usdcBalance = await publicClient.readContract({
      address: USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [vault],
    });
    const youReceive = usdcBalance - usdcBefore;
    const shares = (await publicClient.readContract({
      address: vault,
      abi: vaultAbi,
      functionName: "balanceOf",
      args: [DEPOSITOR],
    })) - sharesBefore;
    // Assert against the minimum, never the quote: the route may pay anything between the two.
    assert.ok(
      youReceive >= minAmountToDeposit,
      `${velora.aggregator}: vault received ${youReceive} USDC units, minimum ${minAmountToDeposit}`,
    );
    assert.ok(shares > 0n, `${velora.aggregator}: no shares minted`);
    await previewValues({ publicClient, vault, wethAddress: WETH, usdcAddress: USDC, youDeposit, youReceive });
  });
});
