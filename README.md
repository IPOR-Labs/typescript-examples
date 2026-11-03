# IPOR Fusion TypeScript Examples

Runnable [IPOR Fusion](https://ipor.io/) Plasma Vault stories in TypeScript and viem, executed on a Hardhat fork. Protocol docs for integrators and agents: https://ipor.io/llms.txt

## Setup

1. Node 22 and pnpm.
2. `pnpm install`
3. Copy `.env.example` to `.env` and set `RPC_URL_BASE` to an archive-capable Base RPC. The fork is pinned to a past block, so a non-archive RPC fails.

## Run

- All stories: `pnpm test`
- One story: `pnpm hardhat test nodejs <file>`
- Types: `pnpm typecheck`

## Stories

| Story | File | What it shows |
| --- | --- | --- |
| S1 | `test/01-create-and-configure-base.ts` | Create and configure a vault on Base |
| S2 | `test/02-read-a-vault-base.ts` | Read a vault's state on Base |

## How to read a story

- Stories do not simulate transactions. A real app should simulate before each transaction.
- Read only the first failure. Later steps depend on earlier ones, so they cascade.
- Zaps do not work for private vaults.
- ABIs and addresses come from the `ipor-abi` repository on `main`.
