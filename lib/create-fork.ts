import { createServer } from 'prool';
import { anvil } from 'prool/instances';
import { FusionChain, ChainIdFusion } from './types';
import { mainnet, arbitrum, base } from 'viem/chains';
import { ENV } from './env';

export const createFork = (chain: FusionChain, forkBlockNumber: bigint) => {
  const server = createServer({
    instance: anvil({
      forkBlockNumber,
      forkUrl: FORK_URL[chain.id],
      autoImpersonate: true,
    }),
  });
  return server;
};

const FORK_URL = {
  [mainnet.id]: ENV.RPC_URL_MAINNET,
  [arbitrum.id]: ENV.RPC_URL_ARBITRUM,
  [base.id]: ENV.RPC_URL_BASE,
} as const satisfies Record<ChainIdFusion, string>;
