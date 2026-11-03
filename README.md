# IPOR Fusion TypeScript Examples

Runnable [IPOR Fusion](https://ipor.io/) Plasma Vault stories in TypeScript and viem, executed on a Hardhat fork. Protocol docs for integrators and agents: https://ipor.io/llms.txt

## Setup

1. Node 22.18 and pnpm.
2. `pnpm install`
3. Copy `.env.example` to `.env` and set `RPC_URL_BASE` to an archive-capable Base RPC. The fork is pinned to a past block, so a non-archive RPC fails.
   Set `RPC_URL_MAINNET` to an archive-capable Ethereum RPC for S5 and the Ethereum part of S6.

## Run

- All stories: `pnpm test`
- One story: `pnpm hardhat test nodejs <file>`
- Types: `pnpm typecheck`

## Stories

| Story | File | What it shows |
| --- | --- | --- |
| S1 | `test/01-create-and-configure-base.ts` | Create and configure a vault on Base |
| S2 | `test/02-read-a-vault-base.ts` | Read a vault's state on Base |
| S3 | `test/03-direct-deposit-base.ts` | Deposit directly, with a referral code and under a deposit fee on Base |
| S4 | `test/04-private-vault-base.ts` | Whitelist an EOA and deposit into a private vault on Base |
| S5 | `test/05-token-zaps-ethereum.ts` | Wrap ETH, stake ETH, unwrap wstETH and mint rUSD into vaults on Ethereum |
| S6 | `test/06-aggregator-zap-ethereum.ts`, `test/06-aggregator-zap-base.ts` | Zap through KyberSwap and Velora on Ethereum, and KyberSwap on Base |
| S7 | `test/07-alpha-cycle-base.ts` | Alpha supplies to Aave V3, refreshes balances, exits |
| S8 | `test/08-instant-withdraw-and-redeem-base.ts` | Instant withdraw and redeem, instant-withdrawal fuses, withdraw fee |
| S9 | `test/09-scheduled-withdraw-base.ts` | Request, release, redeem from a request, partial, overwrite, expiry |
| S10 | `test/10-vault-operations-base.ts` | Fees, harvest, supply cap and share transfers on Base |
| S11 | `test/11-governance-base.ts` | Execution delays, scheduled calls, Guardian cancel and pause on Base |
| S12 | `test/12-erc4626-market-base.ts` | Install, supply and exit an ERC-4626 market on Base |
| S13 | `test/13-morpho-lend-market-base.ts` | Install, supply and exit a Morpho Lend market on Base |

## How to read a story

- Stories do not simulate transactions. A real app should simulate before each transaction.
- The pre-flight reads in each story (balances, limits, previews, roles) exist to build a transparent UI: show the user what a transaction will do before they send it.
- Read only the first failure. Later steps depend on earlier ones, so they cascade.
- The factory installs `BurnRequestFeeFuseV2` in every clone, so `getFuses` returns it even on a fresh vault.
- Zaps and referral deposits do not work on private vaults, because WHITELIST_ROLE is granted only to EOAs, never to a contract such as the zap or the referral wrapper.
- S6 replays recorded aggregator routes at their pinned block. `node scripts/record-zap-fixture.ts <aggregator> <chain>` re-records one as `test/fixtures/<aggregator>-<chain>-<amount-from>-weth-to-usdc-<block>.json` (update the readers' file names), then update its network's block in `hardhat.config.ts`. Both Ethereum fixtures must share one block: re-record them until they do, put that block in the `ethereum` network, and re-run S5 at that block. The Base fixture keeps its own `base-kyberswap` network.
- Every story is one file, except the ABIs: each hand-written ABI is a shared `abis/<name>.abi.ts` file (the union of the items the stories use) that the stories import.
- ABIs and addresses come from the `ipor-abi` repository (`mainnet/mainnet-base-fusion` at `8b1be92`, `mainnet/addresses.json` at `e228075`).
- The factory's `getDaoFeePackages` is not in ipor-abi's Base folder, so S10 writes it by hand from `ipor-fusion` at `004d054`, as its source comment names.
