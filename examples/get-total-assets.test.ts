import { it, beforeEach, afterEach, expect, describe } from 'vitest';
import { mainnet } from 'viem/chains';
import { createPublicTestClient } from '../lib/clients';
import { createFork } from '../lib/create-fork';
import { getTotalAssets } from './get-total-assets';
import { getMarketIds } from './get-market-ids';
import { getFuses } from './get-fuses';

const BLOCK_NUMBER = 22525475n;

const server = createFork(mainnet, BLOCK_NUMBER);

beforeEach(async () => {
  await server.start();
});

afterEach(async () => {
  await server.stop();
});

describe('getTotalAssets', () => {
  it('should get total assets of the vault', async () => {
    const plasmaVault = '0x43a32d4f6c582f281c52393f8f9e5ace1d4a1e68';
    const publicClient = createPublicTestClient(server, mainnet);
    
    const fuses = await getFuses(publicClient, {
      plasmaVault,
    });

    const marketIds = await getMarketIds(publicClient, {
      fuses,
    });

    const totalAssets = await getTotalAssets(publicClient, {
      plasmaVault,
      marketIds,
    });

    expect(totalAssets).toBe(238043959658n);
  }, 30_000);
});