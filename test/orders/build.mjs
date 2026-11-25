// Compiles contracts/PrivoOrders.sol with solc 0.8.26 (same settings as the Block desk) and writes
// contracts/out/PrivoOrders.json (abi, creation bytecode, runtime bytecode, compiler settings). From the repo root:
//   node test/orders/build.mjs
import fs from "node:fs";
import { createRequire } from "node:module";
import { compile, SETTINGS } from "../blockdesk/compile.mjs";
const solc = createRequire(new URL("../sim/package.json", import.meta.url))("solc");

const c = compile({ "PrivoOrders.sol": "../../contracts/PrivoOrders.sol" })["PrivoOrders.sol"].PrivoOrders;
fs.mkdirSync(new URL("../../contracts/out/", import.meta.url), { recursive: true });
const art = { contractName: "PrivoOrders", compiler: "solc " + solc.version(), settings: SETTINGS, abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, deployedBytecode: "0x" + c.evm.deployedBytecode.object };
fs.writeFileSync(new URL("../../contracts/out/PrivoOrders.json", import.meta.url), JSON.stringify(art, null, 1));
console.log("compiled with", art.compiler, "| creation", art.bytecode.length / 2 - 1, "bytes | runtime", art.deployedBytecode.length / 2 - 1, "bytes");
