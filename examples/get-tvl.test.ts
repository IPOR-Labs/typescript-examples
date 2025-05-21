import { it, beforeEach, afterEach, expect, describe } from 'vitest';
import { mainnet } from 'viem/chains';
import { createPublicTestClient } from '../lib/clients';
import { createFork } from '../lib/create-fork';
import { getTvl } from './get-tvl';
import { formatUnits } from 'viem';

const BLOCK_NUMBER = 22525475n;

const server = createFork(mainnet, BLOCK_NUMBER);

beforeEach(async () => {
  await server.start();
});

afterEach(async () => {
  await server.stop();
});

describe('getTvl', () => {
  it('should get total value locked of the vault in USD', async () => {
    const plasmaVault = '0x43a32d4f6c582f281c52393f8f9e5ace1d4a1e68';
    const publicClient = createPublicTestClient(server, mainnet);

    const tvl = await getTvl(publicClient, {
      plasmaVault,
    });

    expect(tvl).toStrictEqual([
      238007300888n,
      6,
    ]);

    const [tvlAmount, tvlDecimals] = tvl;

    expect(formatUnits(tvlAmount, tvlDecimals)).toBe('238007.300888');
  }, 30_000);
});