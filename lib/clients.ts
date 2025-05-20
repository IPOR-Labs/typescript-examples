import {
  Address,
  createTestClient,
  http,
  publicActions,
  walletActions,
  Chain,
} from 'viem';
import { CreateServerReturnType } from 'prool';

const getRpcUrls = (
  server: CreateServerReturnType,
  instanceNumber: number = 1,
) => {
  const address = server.address();
  const port = address?.port;

  if (port === undefined) throw new Error('port is undefined');

  return {
    default: {
      http: [`http://localhost:${port}/${instanceNumber}`],
      webSocket: [`ws://localhost:${port}/${instanceNumber}`],
    },
  };
};

export const createPublicTestClient = (
  server: CreateServerReturnType,
  chain: Chain,
  instanceNumber?: number,
) => {
  const rpcUrls = getRpcUrls(server, instanceNumber);

  return createTestClient({
    chain: {
      ...chain,
      rpcUrls,
    },
    mode: 'anvil',
    transport: http(rpcUrls.default.http[0]),
  }).extend(publicActions);
};

export const createWalletTestClient = (
  server: CreateServerReturnType,
  chain: Chain,
  account: Address,
  instanceNumber?: number,
) => {
  const rpcUrls = getRpcUrls(server, instanceNumber);

  return createTestClient({
    account,
    chain: {
      ...chain,
      rpcUrls,
    },
    mode: 'anvil',
    transport: http(rpcUrls.default.http[0]),
  }).extend(walletActions);
};




