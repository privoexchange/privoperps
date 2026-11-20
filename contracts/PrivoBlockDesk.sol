// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title PRIVO Block Desk
/// @notice Sealed-quote OTC settlement on Robinhood Chain.
/// A maker shares a private request. Takers answer off-chain by signing an EIP-712 Quote that names the maker,
/// both tokens, both amounts, a nonce and a deadline. Only the winning quote ever reaches the chain: the maker
/// calls settle(), and both legs move in one transaction or not at all.
/// The contract never holds funds, has no owner, no admin, no upgrade path and no pause switch.
/// Fee: 0.10% of the USDG leg (or of the taker leg when neither side is USDG), sent to the PRIVO fee Safe.
contract PrivoBlockDesk {
    /// PRIVO fee Safe (2 of 3) on Robinhood Chain.
    address public constant FEE_WALLET = 0xCc051cf47547386bA147FDDfcBCFE00E791C1418;
    /// USDG on Robinhood Chain, the leg the fee is charged on when present.
    address public constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint256 public constant FEE_BIPS = 10;

    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(address maker,address taker,address makerToken,uint256 makerAmount,address takerToken,uint256 takerAmount,bytes32 blockId,uint256 nonce,uint256 deadline)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("PRIVO Block Desk");
    bytes32 private constant VERSION_HASH = keccak256("1");

    struct Quote {
        address maker;       // the only address allowed to settle this quote
        address taker;       // signer of the quote
        address makerToken;  // token the maker gives
        uint256 makerAmount;
        address takerToken;  // token the taker gives
        uint256 takerAmount;
        bytes32 blockId;     // the maker's private request this quote answers
        uint256 nonce;       // per taker, single use
        uint256 deadline;    // unix seconds
    }

    /// taker => nonce => used or cancelled
    mapping(address => mapping(uint256 => bool)) public nonceUsed;

    event Settled(
        bytes32 indexed blockId, address indexed maker, address indexed taker,
        address makerToken, uint256 makerAmount, address takerToken, uint256 takerAmount,
        address feeToken, uint256 fee
    );
    event NonceCancelled(address indexed taker, uint256 indexed nonce);

    error NotMaker();
    error Expired();
    error NonceAlreadyUsed();
    error BadQuote();
    error BadSignature();
    error TransferFailed(address token, address from, address to, uint256 amount);

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function hashQuote(Quote calldata q) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            QUOTE_TYPEHASH, q.maker, q.taker, q.makerToken, q.makerAmount, q.takerToken, q.takerAmount, q.blockId, q.nonce, q.deadline
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice The fee for a quote, the token it is paid in, and who pays it.
    /// When the taker gives USDG (or neither leg is USDG) the fee comes out of the taker leg, so the maker receives less.
    /// When the maker gives USDG the maker pays the fee on top. The taker always gives and gets exactly what they signed.
    function feeFor(Quote calldata q) public pure returns (address token, uint256 fee, bool makerPays) {
        if (q.makerToken == USDG && q.takerToken != USDG) return (USDG, q.makerAmount * FEE_BIPS / 10_000, true);
        return (q.takerToken, q.takerAmount * FEE_BIPS / 10_000, false);
    }

    /// @notice Maker settles a quote a taker signed. Both parties must have approved this contract for their token.
    function settle(Quote calldata q, bytes calldata takerSignature) external {
        if (msg.sender != q.maker) revert NotMaker();
        if (block.timestamp > q.deadline) revert Expired();
        if (q.makerAmount == 0 || q.takerAmount == 0 || q.makerToken == q.takerToken || q.taker == q.maker || q.taker == address(0)) revert BadQuote();
        if (nonceUsed[q.taker][q.nonce]) revert NonceAlreadyUsed();
        if (!_validSignature(q.taker, hashQuote(q), takerSignature)) revert BadSignature();

        nonceUsed[q.taker][q.nonce] = true;

        (address feeToken, uint256 fee, bool makerPays) = feeFor(q);
        if (makerPays) {
            _pull(q.takerToken, q.taker, q.maker, q.takerAmount);
            _pull(q.makerToken, q.maker, q.taker, q.makerAmount);
            if (fee != 0) _pull(q.makerToken, q.maker, FEE_WALLET, fee);
        } else {
            _pull(q.takerToken, q.taker, q.maker, q.takerAmount - fee);
            if (fee != 0) _pull(q.takerToken, q.taker, FEE_WALLET, fee);
            _pull(q.makerToken, q.maker, q.taker, q.makerAmount);
        }
        emit Settled(q.blockId, q.maker, q.taker, q.makerToken, q.makerAmount, q.takerToken, q.takerAmount, feeToken, fee);
    }

    /// @notice A taker withdraws a quote they signed (or any nonce) before it is settled.
    function cancel(uint256 nonce) external {
        nonceUsed[msg.sender][nonce] = true;
        emit NonceCancelled(msg.sender, nonce);
    }

    function _validSignature(address signer, bytes32 digest, bytes calldata sig) internal view returns (bool) {
        if (signer.code.length > 0) {
            // ERC-1271 smart contract wallets (e.g. a Safe)
            (bool ok, bytes memory ret) = signer.staticcall(abi.encodeWithSelector(0x1626ba7e, digest, sig));
            return ok && ret.length >= 32 && abi.decode(ret, (bytes4)) == 0x1626ba7e;
        }
        if (sig.length != 65) return false;
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        // reject malleable signatures (upper half s)
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) return false;
        address got = ecrecover(digest, v, r, s);
        return got != address(0) && got == signer;
    }

    function _pull(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool))) || token.code.length == 0) revert TransferFailed(token, from, to, amount);
    }
}
