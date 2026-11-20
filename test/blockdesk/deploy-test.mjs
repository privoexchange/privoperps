// Checks the PrivoBlockDesk deployment on Robinhood Chain (read-only, nothing sent):
// - the CREATE2 address follows from this build's bytecode and the salt,
// - the contract at that address has exactly this build's runtime code,
// - before deployment, a simulated deployment would return that address.
//   node test/blockdesk/deploy-test.mjs
import fs from "node:fs";
import { createPublicClient, http, toHex } from "viem";
import { predictedAddress, deployTx, verifyDeployed, CREATE2_DEPLOYER } from "./deploy-core.js";

const DEPLOYED = "0x8D94fCe2925EBA2448DA28f9461c8b644c26b8e7";
const c = createPublicClient({ transport: http("https://robinhood-rpc.publicnode.com", { timeout: 30000 }) });
const art = JSON.parse(fs.readFileSync(new URL("../../contracts/out/PrivoBlockDesk.json", import.meta.url), "utf8"));
const addr = predictedAddress(art.bytecode);
let bad = 0; const check = (ok, m) => { console.log((ok ? "  ok    " : "  FAIL  ") + m); if (!ok) bad++; };

check((await c.getCode({ address: CREATE2_DEPLOYER })) !== undefined, "CREATE2 deployer exists on Robinhood Chain");
check(addr.toLowerCase() === DEPLOYED.toLowerCase(), `CREATE2 address from this build is ${addr}`);
const v = await verifyDeployed(c, addr, art.deployedBytecode);
if (v.deployed) {
  check(v.matches, "the deployed contract's runtime code matches contracts/out/PrivoBlockDesk.json");
} else {
  // Not deployed yet (for example after changing the contract): simulate the deployment instead.
  const from = "0x7a11ce000000000000000000000000000000b0b1", tx = deployTx(art.bytecode);
  const ret = await c.request({ method: "eth_call", params: [{ from, ...tx, gas: toHex(3_000_000n) }, "latest", { [from]: { balance: toHex(10n ** 18n) } }] });
  check(ret.toLowerCase() === addr.toLowerCase(), "simulated deployment returns the predicted address");
}
console.log(bad ? `\n${bad} check(s) failed` : "\nall checks passed");
process.exit(bad ? 1 : 0);
