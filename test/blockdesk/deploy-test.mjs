// Checks the CREATE2 deployment of PrivoBlockDesk on Robinhood Chain, sending nothing. Before deployment it simulates the
// deployment (eth_call) and checks that the deployer returns the predicted address; after deployment it checks that the
// code at that address is exactly this build.
import fs from "node:fs";
import { createPublicClient, http, toHex } from "viem";
import { predictedAddress, deployTx, verifyDeployed, CREATE2_DEPLOYER } from "./deploy-core.js";

const c = createPublicClient({ transport: http("https://robinhood-rpc.publicnode.com", { timeout: 30000 }) });
const art = JSON.parse(fs.readFileSync(new URL("../../contracts/out/PrivoBlockDesk.json", import.meta.url), "utf8"));
const addr = predictedAddress(art.bytecode);
let bad = 0; const check = (ok, m) => { console.log((ok ? "  ok    " : "  FAIL  ") + m); if (!ok) bad++; };
check(!!(await c.getCode({ address: CREATE2_DEPLOYER })), "CREATE2 deployer exists on Robinhood Chain");
const v = await verifyDeployed(c, addr, art.deployedBytecode);
if (v.deployed) {
  check(v.matches, `PrivoBlockDesk is deployed at ${addr} and its code is exactly this build`);
} else {
  const from = "0x7a11ce000000000000000000000000000000b0b1", tx = deployTx(art.bytecode);
  const ret = await c.request({ method: "eth_call", params: [{ from, ...tx, gas: toHex(3_000_000n) }, "latest", { [from]: { balance: toHex(10n ** 18n) } }] });
  check(ret.toLowerCase() === addr.toLowerCase(), `not deployed yet; a simulated deployment returns the predicted address ${addr}`);
}
console.log(bad ? `\n${bad} failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
