import { it, beforeEach, afterEach, expect, describe } from 'vitest';
import { mainnet } from 'viem/chains';
import { createPublicTestClient } from '../lib/clients';
import { createFork } from '../lib/create-fork';
import { getFuses } from './get-fuses';

const BLOCK_NUMBER = 22525475n;

const server = createFork(mainnet, BLOCK_NUMBER);

beforeEach(async () => {
  await server.start();
});

afterEach(async () => {
  await server.stop();
});

describe('getFuses', () => {
  it('should get fuses of the vault', async () => {
    const plasmaVault = '0x43a32d4f6c582f281c52393f8f9e5ace1d4a1e68';
    const publicClient = createPublicTestClient(server, mainnet);

    const fuses = await getFuses(publicClient, {
      plasmaVault,
    });

    expect(fuses).toStrictEqual([
      "0x79e8B115Bd41baee318c1940F42F1a2d94D29ab4",
      "0x7130383298822097531Cf5cc5e3414dda1e09542",
      "0x08dFdBB6Ecf19f1fc974E0675783E1150B2B650F",
      "0x906Af6A42079AdAF1aBD92F924a5d4263653AF0d",
      "0x12FD0EE183c85940CAedd4877f5d3Fc637515870",
      "0x40430a509188b71BdA9a0c06b132e978Ea2015BE",
    ]);
  }, 30_000);
});