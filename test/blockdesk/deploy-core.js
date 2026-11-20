// Deterministic deployment of PrivoBlockDesk through the standard CREATE2 deployer
// (0x4e59b44847b379578588920cA78FbF26c0B4956C, present on Robinhood Chain). Same bytecode + salt = same address,
// whoever sends the transaction, so the address can be checked and published before deployment.
import { getContractAddress, concatHex, keccak256 } from "viem";

export const CREATE2_DEPLOYER = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
export const SALT = keccak256(new TextEncoder().encode("PRIVO Block Desk v1"));

export const predictedAddress = bytecode => getContractAddress({ opcode: "CREATE2", from: CREATE2_DEPLOYER, salt: SALT, bytecode });
export const deployTx = bytecode => ({ to: CREATE2_DEPLOYER, data: concatHex([SALT, bytecode]) });
// The live code must equal the compiled runtime code exactly.
export async function verifyDeployed(client, address, deployedBytecode) {
  const code = await client.getCode({ address });
  return { deployed: !!code && code !== "0x", matches: !!code && code.toLowerCase() === deployedBytecode.toLowerCase() };
}
