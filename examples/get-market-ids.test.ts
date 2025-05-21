import { it, beforeEach, afterEach, expect, describe } from 'vitest';
import { mainnet } from 'viem/chains';
import { createPublicTestClient } from '../lib/clients';
import { createFork } from '../lib/create-fork';
import { getFuses } from './get-fuses';
import { getMarketIds } from './get-market-ids';

const BLOCK_NUMBER = 22525475n;

const server = createFork(mainnet, BLOCK_NUMBER);

beforeEach(async () => {
  await server.start();
});

afterEach(async () => {
  await server.stop();
});

describe('getMarketIds', () => {
  it('should get market ids of the vault', async () => {
    const plasmaVault = '0x43a32d4f6c582f281c52393f8f9e5ace1d4a1e68';
    const publicClient = createPublicTestClient(server, mainnet);

    const fuses = await getFuses(publicClient, {
      plasmaVault,
    });

    const marketIds = await getMarketIds(publicClient, {
      fuses,
    });

    expect(marketIds).toStrictEqual([
      115792089237316195423570985008687907853269984665640564039457584007913129639935n,
      100001n,
      12n,
      23n,
    ]);
  }, 30_000);
});