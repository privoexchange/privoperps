// Compiles contracts/PrivoBlockDesk.sol with solc 0.8.26 and writes contracts/out/PrivoBlockDesk.json
// (abi, creation bytecode, runtime bytecode, compiler settings). Run from the repo root:
//   node test/blockdesk/compile.mjs
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(new URL("../../package.json", import.meta.url));
const solc = require("solc");

export const SETTINGS = { optimizer: { enabled: true, runs: 1000 }, evmVersion: "cancun", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } };

export function compile(files) {
  const sources = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { content: fs.readFileSync(new URL(v, import.meta.url), "utf8") }]));
  const out = JSON.parse(solc.compile(JSON.stringify({ language: "Solidity", sources, settings: SETTINGS })));
  const errs = (out.errors || []).filter(e => e.severity === "error");
  if (errs.length) throw new Error(errs.map(e => e.formattedMessage).join("\n"));
  for (const w of (out.errors || []).filter(e => e.severity !== "error")) console.error("warning:", w.message);
  return out.contracts;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("compile.mjs")) {
  const c = compile({ "PrivoBlockDesk.sol": "../../contracts/PrivoBlockDesk.sol" })["PrivoBlockDesk.sol"].PrivoBlockDesk;
  fs.mkdirSync(new URL("../../contracts/out/", import.meta.url), { recursive: true });
  const art = { contractName: "PrivoBlockDesk", compiler: "solc " + solc.version(), settings: SETTINGS, abi: c.abi, bytecode: "0x" + c.evm.bytecode.object, deployedBytecode: "0x" + c.evm.deployedBytecode.object };
  fs.writeFileSync(new URL("../../contracts/out/PrivoBlockDesk.json", import.meta.url), JSON.stringify(art, null, 1));
  console.log("compiled with", art.compiler, "| creation", art.bytecode.length / 2 - 1, "bytes | runtime", art.deployedBytecode.length / 2 - 1, "bytes");
}
