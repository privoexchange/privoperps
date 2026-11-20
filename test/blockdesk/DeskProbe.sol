// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

// Test helper only (never deployed). Placed by state override, it plays the maker: approves the desk for its token,
// calls settle with the given calldata `times` times, and reports balances before and after plus each call's result.
contract DeskProbe {
    function run(address desk, address makerToken, bytes calldata settleCall, uint256 times, address[] calldata toks, address[] calldata accts)
        external returns (uint256[] memory pre, uint256[] memory post, bytes[] memory results)
    {
        (bool s,) = makerToken.call(abi.encodeWithSignature("approve(address,uint256)", desk, type(uint256).max));
        require(s, "approve");
        pre = snap(toks, accts);
        results = new bytes[](times);
        for (uint256 i; i < times; i++) {
            (bool ok, bytes memory ret) = desk.call(settleCall);
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
