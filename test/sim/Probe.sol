// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20 { function balanceOf(address) external view returns (uint256); }
interface IPermit2 { function approve(address token, address spender, uint160 amount, uint48 expiration) external; }
interface IUR { function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable; }

// Placed with a state override; it acts as the trader. It approves Permit2, calls the
// Universal Router, and reports token balances before and after, plus gas used.
contract Probe {
    function run(address router, address permit2, address tokenIn, address[] calldata toks, address[] calldata accts,
                 bytes calldata commands, bytes[] calldata inputs)
        external returns (uint256[] memory pre, uint256[] memory post, uint256 gasUsed, bool ok, bytes memory err)
    {
        (bool s,) = tokenIn.call(abi.encodeWithSignature("approve(address,uint256)", permit2, type(uint256).max));
        require(s, "approve permit2");
        IPermit2(permit2).approve(tokenIn, router, type(uint160).max, type(uint48).max);
        pre = snap(toks, accts);
        uint256 g = gasleft();
        try IUR(router).execute(commands, inputs, block.timestamp + 600) { ok = true; } catch (bytes memory e) { err = e; }
        gasUsed = g - gasleft();
        post = snap(toks, accts);
    }

    function snap(address[] calldata toks, address[] calldata accts) internal view returns (uint256[] memory b) {
        b = new uint256[](toks.length * accts.length);
        for (uint256 i; i < toks.length; i++)
            for (uint256 j; j < accts.length; j++) b[i * accts.length + j] = IERC20(toks[i]).balanceOf(accts[j]);
    }
}
