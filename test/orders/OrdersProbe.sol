// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Test helper only (never deployed). Placed by state override, it plays the filler: calls fill with the given calldata
// once per entry in `calls`, and reports balances before and after plus each call's result.
contract OrdersProbe {
    function run(address orders, bytes[] calldata calls, address[] calldata toks, address[] calldata accts)
        external returns (uint256[] memory pre, uint256[] memory post, bytes[] memory results)
    {
        pre = snap(toks, accts);
        results = new bytes[](calls.length);
        for (uint256 i; i < calls.length; i++) {
            (bool ok, bytes memory ret) = orders.call(calls[i]);
            results[i] = ok ? bytes("OK") : ret;
        }
        post = snap(toks, accts);
    }

    function snap(address[] calldata toks, address[] calldata accts) internal view returns (uint256[] memory b) {
        b = new uint256[](toks.length * accts.length);
        for (uint256 i; i < toks.length; i++)
            for (uint256 j; j < accts.length; j++) {
                (, bytes memory r) = toks[i].staticcall(abi.encodeWithSignature("balanceOf(address)", accts[j]));
                b[i * accts.length + j] = abi.decode(r, (uint256));
            }
    }
}
